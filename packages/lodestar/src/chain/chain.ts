/**
 * @module chain
 */

import assert from "assert";
import BN from "bn.js";
import {EventEmitter} from "events";
import {hashTreeRoot} from "@chainsafe/ssz";

import {Attestation, BeaconBlock, BeaconState, number64, uint16, uint64} from "../types";
import {DEPOSIT_CONTRACT_TREE_DEPTH, GENESIS_SLOT} from "../constants";

import {IBeaconDb} from "../db";
import {IEth1Notifier} from "../eth1";
import {ILogger} from "../logger";
import {IBeaconConfig} from "../config";

import {getEmptyBlock, initializeBeaconStateFromEth1, isValidGenesisState} from "./genesis/genesis";

import {stateTransition} from "./stateTransition";

import {LMDGHOST, StatefulDagLMDGHOST} from "./forkChoice";
import {getAttestingIndices, computeEpochOfSlot} from "./stateTransition/util";
import {IBeaconChain} from "./interface";
import {ProgressiveMerkleTree} from "../util/merkleTree";
import {processSortedDeposits} from "../util/deposits";
import {OpPool} from "../opPool";
import {Block} from "ethers/providers";

export interface IBeaconChainModules {
  config: IBeaconConfig;
  opPool: OpPool;
  db: IBeaconDb;
  eth1: IEth1Notifier;
  logger: ILogger;
}

export class BeaconChain extends EventEmitter implements IBeaconChain {

  public chain: string;
  public latestState: BeaconState = null;
  public forkChoice: LMDGHOST;
  public chainId: uint16;
  public networkId: uint64;

  private readonly config: IBeaconConfig;
  private db: IBeaconDb;
  private opPool: OpPool;
  private eth1: IEth1Notifier;
  private logger: ILogger;

  public constructor(opts, {config, db, eth1, opPool, logger}: IBeaconChainModules) {
    super();
    this.chain = opts.chain;
    this.config = config;
    this.db = db;
    this.eth1 = eth1;
    this.opPool = opPool;
    this.logger = logger;
    this.forkChoice = new StatefulDagLMDGHOST();
    this.chainId = 0; // TODO make this real
    this.networkId = new BN(0); // TODO make this real

  }

  public async start(): Promise<void> {
    const state = await this.db.getLatestState();
    // if state doesn't exist in the db, the chain maybe hasn't started
    if(!state) {
      // check every block if genesis
      this.eth1.on('block', this.checkGenesis.bind(this));
    }
    this.latestState = state;
  }

  public async stop(): Promise<void> {
    this.eth1.removeListener('block', this.checkGenesis.bind(this));
  }


  public async receiveAttestation(attestation: Attestation): Promise<void> {
    const validators = getAttestingIndices(
      this.config, this.latestState, attestation.data, attestation.aggregationBits);
    const balances = validators.map((index) => this.latestState.balances[index]);
    for (let i = 0; i < validators.length; i++) {
      this.forkChoice.addAttestation(attestation.data.beaconBlockRoot, validators[i], balances[i]);
    }
    this.emit('processedAttestation', attestation);
  }

  public async receiveBlock(block: BeaconBlock): Promise<void> {
    const isValidBlock = await this.isValidBlock(this.latestState, block);
    assert(isValidBlock);

    // process current slot
    await this.runStateTransition(block, this.latestState);
    await this.opPool.processBlockOperations(block);

    // forward processed block for additional processing
    this.emit('processedBlock', block);
  }

  public async applyForkChoiceRule(): Promise<void> {
    const currentRoot = await this.db.getChainHeadRoot();
    const headRoot = this.forkChoice.head();
    if (!currentRoot.equals(headRoot)) {
      const block = await this.db.getBlock(headRoot);
      await this.db.setChainHeadRoots(currentRoot, block.stateRoot, block);
    }
  }

  public async initializeBeaconChain(genesisState: BeaconState, merkleTree: ProgressiveMerkleTree): Promise<void> {
    const genesisBlock = getEmptyBlock();
    const stateRoot = hashTreeRoot(genesisState, this.config.types.BeaconState);
    genesisBlock.stateRoot = stateRoot;
    const blockRoot = hashTreeRoot(genesisBlock, this.config.types.BeaconBlock);
    this.latestState = genesisState;
    await Promise.all([
      this.db.setBlock(blockRoot, genesisBlock),
      this.db.setState(stateRoot, genesisState),
    ]);
    await Promise.all([
      this.db.setChainHeadRoots(blockRoot, stateRoot, genesisBlock, genesisState),
      this.db.setJustifiedBlockRoot(blockRoot, genesisBlock),
      this.db.setFinalizedBlockRoot(blockRoot, genesisBlock),
      this.db.setLatestStateRoot(stateRoot, genesisState),
      this.db.setJustifiedStateRoot(stateRoot, genesisState),
      this.db.setFinalizedStateRoot(stateRoot, genesisState),
      this.db.setMerkleTree(genesisState.eth1DepositIndex, merkleTree)
    ]);
    this.forkChoice.addBlock(genesisBlock.slot, blockRoot, Buffer.alloc(32));
    this.forkChoice.setJustified(blockRoot);
    this.forkChoice.setFinalized(blockRoot);
  }

  public async isValidBlock(state: BeaconState, block: BeaconBlock): Promise<boolean> {
    // The parent block with root block.previous_block_root has been processed and accepted.
    const hasParent = await this.db.hasBlock(block.parentRoot);
    if (!hasParent) {
      return false;
    }
    // An Ethereum 1.0 block pointed to by the state.
    // latest_eth1_data.block_hash has been processed and accepted.
    // TODO: implement

    // The node's Unix time is greater than or equal to state.
    const stateSlotTime = state.genesisTime + ((block.slot - GENESIS_SLOT) * this.config.params.SECONDS_PER_SLOT);
    if (Math.floor(Date.now() / 1000) < stateSlotTime) {
      return false;
    }
    return true;
  }

  private async runStateTransition(block: BeaconBlock, state: BeaconState): Promise<BeaconState> {
    const preSlot = state.slot;
    const preFinalizedEpoch = state.finalizedCheckpoint.epoch;
    const preJustifiedEpoch = state.currentJustifiedCheckpoint.epoch;
    // Run the state transition
    let newState: BeaconState;
    try {
      newState = stateTransition(this.config, state, block, true);
    }catch (e) {
      // store block root in db and terminate
      const blockRoot = hashTreeRoot(block, this.config.types.BeaconBlock);
      await this.db.setBadBlockRoot(blockRoot);
      this.logger.warn( `Found bad block, block root: ${blockRoot} ` + e.message + '\n' );
      return;
    }

    // On successful transition, update system state
    const blockRoot = hashTreeRoot(block, this.config.types.BeaconBlock);
    await Promise.all([
      this.db.setBlock(blockRoot, block),
      this.db.setState(block.stateRoot, newState),
    ]);
    this.forkChoice.addBlock(block.slot, blockRoot, block.parentRoot);
    this.updateDepositMerkleTree(newState);

    // Post-epoch processing
    if (computeEpochOfSlot(this.config, preSlot) < computeEpochOfSlot(this.config, newState.slot)) {
      // Update FFG Checkpoints
      // Newly justified epoch
      if (preJustifiedEpoch < newState.currentJustifiedCheckpoint.epoch) {
        const justifiedBlock = await this.db.getBlock(newState.currentJustifiedCheckpoint.root);
        const [justifiedState] = await Promise.all([
          this.db.getState(justifiedBlock.stateRoot),
          this.db.setJustifiedBlockRoot(blockRoot, block),
        ]);
        await this.db.setJustifiedStateRoot(justifiedBlock.stateRoot, justifiedState);
        this.forkChoice.setJustified(blockRoot);
      }
      // Newly finalized epoch
      if (preFinalizedEpoch < newState.finalizedCheckpoint.epoch) {
        const finalizedBlock = await this.db.getBlock(newState.finalizedCheckpoint.root);
        const [finalizedState] = await Promise.all([
          this.db.getState(finalizedBlock.stateRoot),
          this.db.setFinalizedBlockRoot(blockRoot, block),
        ]);
        await this.db.setFinalizedStateRoot(finalizedBlock.stateRoot, finalizedState);
        this.forkChoice.setFinalized(blockRoot);
      }
    }
    return newState;
  }

  private async updateDepositMerkleTree(newState: BeaconState): Promise<void> {
    let [deposits, merkleTree] = await Promise.all([
      this.db.getDeposits(),
      this.db.getMerkleTree(newState.eth1DepositIndex - newState.eth1Data.depositCount)
    ]);
    processSortedDeposits(
      this.config,
      deposits,
      newState.eth1DepositIndex,
      newState.eth1Data.depositCount,
      (deposit, index) => {
        merkleTree.add(index + newState.eth1DepositIndex, hashTreeRoot(deposit.data, this.config.types.DepositData));
        return deposit;
      }
    );
    //TODO: remove deposits with index <= newState.depositIndex
    await this.db.setMerkleTree(newState.eth1DepositIndex, merkleTree);
  }

  private async checkGenesis(eth1Block: Block): Promise<void> {
    this.logger.info(`Checking if block ${eth1Block.hash} will form valid genesis state`);
    const deposits = await this.opPool.deposits.getAll();
    const merkleTree = ProgressiveMerkleTree.empty(DEPOSIT_CONTRACT_TREE_DEPTH);
    const depositsWithProof = deposits
      .map((deposit, index) => {
        merkleTree.add(index, hashTreeRoot(deposit.data, this.config.types.DepositData));
        return deposit;
      })
      .map((deposit, index) => {
        deposit.proof = merkleTree.getProof(index);
        return deposit;
      });
    const genesisState = initializeBeaconStateFromEth1 (
      this.config,
      Buffer.from(eth1Block.hash.replace("0x", ""), "hex"),
      eth1Block.timestamp,
      depositsWithProof
    );
    if(!isValidGenesisState(this.config, genesisState)) {
      this.logger.info(`Eth1 block ${eth1Block.hash} is NOT forming valid genesis state`);
      return;
    }
    this.logger.info(`Initializing beacon chain with eth1 block ${eth1Block.hash}`);
    await this.initializeBeaconChain(genesisState, merkleTree);
  }

  public isInitialized(): boolean {
    return !!this.latestState;
  }
}
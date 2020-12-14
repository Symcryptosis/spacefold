import { ethers, providers } from "ethers";
import { BrowserNode } from "@connext/vector-browser-node";
import {
  DEFAULT_CHANNEL_TIMEOUT,
  DEFAULT_TRANSFER_TIMEOUT,
} from "@connext/vector-types";
import { createlockHash, getRandomBytes32 } from "@connext/vector-utils";
import {
  ConditionalTransferCreatedPayload,
  FullChannelState,
  TransferNames,
} from "@connext/vector-types";
import { ENVIRONMENT } from "../constants";

declare global {
  interface Window {
    ethereum: any;
  }
}

class Connext {
  connextClient: BrowserNode;
  config: {
    publicIdentifier: string;
    signerAddress: string;
    index: number;
  };
  provider: providers.Web3Provider;
  signer: providers.JsonRpcSigner;

  // counterparty = "vector7tbbTxQp8ppEQUgPsbGiTrVdapLdU5dH7zTbVuXRf1M4CEBU9Q";
  counterparty = "vector8Uz1BdpA9hV5uTm6QUv5jj1PsUyCH8m8ciA94voCzsxVmrBRor"; // local

  // Create methods
  async connectNode() {
    const iframeSrc = "http://localhost:3030"
    const supportedChains: number[] = [];
    ENVIRONMENT.map(async (t) => {
      supportedChains.push(t.chainId);
    });
    const routerPublicIdentifier: string = this.counterparty;

    console.log("Connect Node");
    if (!this.connextClient) {
      try {
        const client = new BrowserNode({
          iframeSrc,
          supportedChains,
          routerPublicIdentifier,
        });
        await client.init();
        this.connextClient = client;
      } catch (e) {
        console.error(e);
        throw new Error(`connecting to iframe: ${e}`);
      }
      console.log("connection success");
    }

    const configRes = await this.connextClient.getConfig();
    if (!configRes[0])
      throw new Error(`Error getConfig: node connection failed`);

    console.log("GET CONFIG: ", configRes[0]);
    this.config = configRes[0];
  }

  async updateChannel(channelAddress: string): Promise<FullChannelState> {
    const res = await this.connextClient.getStateChannel({ channelAddress });
    if (res.isError) {
      throw new Error(`Error getting state channel ${res.getError()}`);
    }
    const channel = res.getValue();
    console.log("Updated channel:", channel);
    return channel;
  }

  async getChannelByParticipants(
    publicIdentifier: string,
    counterparty: string,
    chainId: number
  ): Promise<FullChannelState> {
    let channelState: any;
    const res = await this.connextClient!.getStateChannelByParticipants({
      publicIdentifier: publicIdentifier,
      counterparty: counterparty,
      chainId: chainId,
    });
    if (res.isError) {
      throw new Error(
        `Error getting state channel by participants ${res.getError()}`
      );
    }
    channelState = res.getValue();
    return channelState;
  }

  async connectMetamask(chainId: number) {
    if (typeof window === "undefined" || !window.ethereum) {
      alert("Web3 browser is required");
      throw new Error("No Web3 detected");
    }
    try {
      await window.ethereum.enable();
    } catch (e) {
      throw new Error(`Error connecting to Metamask: ${e}`);
    }

    const provider = new ethers.providers.Web3Provider(window.ethereum);
    const network = await provider.getNetwork();
    if (network.chainId !== chainId) {
      alert(`Please switch to chainId ${chainId} and try again`);
      return;
    }
    this.provider = provider;
    this.signer = this.provider.getSigner();
  }

  // TODO: get user on chain balance
  // async getOnChainBalance(chainId: number) {

  //   let customHttpProvider = new ethers.providers.JsonRpcProvider(url);
  // }

  async basicSanitation(params: {
    value?: string;
    fromChainId?: number;
    fromAssetId?: string;
    toChainId?: number;
    toAssetId?: string;
    withdrawalAddress?: string;
  }) {
    if (!this.connextClient) {
      throw new Error("iframe Connection failed");
    }

    if (!this.config) {
      throw new Error("Node Connection failed");
    }

    if (!this.config.publicIdentifier) {
      throw new Error("user publicIdentifier missing");
    }

    if (params.value) {
      if (ethers.utils.parseEther(params.value).isZero()) {
        throw new Error("Value can't be zero");
      }
    }

    if (params.withdrawalAddress) {
      if (!ethers.utils.isAddress(params.withdrawalAddress)) {
        throw new Error("Invalid Recipient Address");
      }
    }
    console.log("Valid params");
  }

  async deposit(chainId: number, assetId: string, amount: string) {
    await this.basicSanitation({
      fromChainId: chainId,
      fromAssetId: assetId,
      value: amount,
    });

    const channelState = await this.getChannelByParticipants(
      this.config.publicIdentifier,
      this.counterparty,
      chainId
    );

    await this.connectMetamask(chainId);

    try {
      const response = await this.signer.sendTransaction({
        to: channelState.channelAddress,
        value: ethers.utils.parseEther(amount),
      });
      const NUM_CONFIRMATIONS = 1;
      console.log(
        `Deposit sent, tx: ${response.hash}, waiting for ${NUM_CONFIRMATIONS} confirmations`
      );
      await response.wait(NUM_CONFIRMATIONS); // NUM_CONFIRMATIONS confirmations just in case
    } catch (e) {
      console.error(e);
      throw new Error(`Deposit onChain: ${e}`);
    }
    console.log(`Deposit tx received, reconciling deposit`);

    await this.reconcileDeposit(channelState.channelAddress, assetId);
    await this.updateChannel(channelState.channelAddress);
  }

  async reconcileDeposit(channelAddress: string, assetId: string) {
    const depositRes = await this.connextClient.reconcileDeposit({
      channelAddress: channelAddress,
      assetId,
    });
    if (depositRes.isError) {
      throw new Error(`Error reconciling deposit: ${depositRes.getError()}`);
    }
    console.log(`Deposit reconciled: ${JSON.stringify(depositRes.getValue())}`);
  }

  async transfer(
    senderChainId: number,
    assetId: string,
    value: string,
    receiverChainId: number
  ) {
    await this.basicSanitation({
      fromChainId: senderChainId,
      fromAssetId: assetId,
      toChainId: receiverChainId,
      value: value,
    });

    const recipient = this.config.publicIdentifier;
    const preImage = getRandomBytes32();
    const amount = ethers.utils.parseEther(value);

    const senderChannelState = await this.getChannelByParticipants(
      this.config.publicIdentifier,
      this.counterparty,
      senderChainId
    );
    const receiverChannelState = await this.getChannelByParticipants(
      this.config.publicIdentifier,
      this.counterparty,
      receiverChainId
    );
    console.log(
      `Sending ${value} from ${senderChannelState.channelAddress} to ${receiverChannelState.channelAddress} using preImage ${preImage}`
    );

    const event: Promise<ConditionalTransferCreatedPayload> = new Promise(
      (res) => {
        this.connextClient.on("CONDITIONAL_TRANSFER_CREATED", (payload) => {
          if (payload.channelAddress !== receiverChannelState.channelAddress) {
            return;
          }
          console.log(`Received CONDITIONAL_TRANSFER_CREATED event: `, payload);
          res(payload);
        });
      }
    );
    const transferRes = await this.connextClient.conditionalTransfer({
      type: TransferNames.HashlockTransfer,
      channelAddress: senderChannelState.channelAddress,
      recipientChainId: receiverChainId,
      assetId,
      amount: amount.toString(),
      recipient,
      details: {
        lockHash: createlockHash(preImage),
        expiry: "0",
      },
      timeout: DEFAULT_TRANSFER_TIMEOUT.toString(),
      meta: {},
    });
    if (transferRes.isError) {
      throw new Error(`Error transferring: ${transferRes.getError()}`);
    }

    console.log(
      `Transfer from for chain: ${senderChainId} to chain ${receiverChainId} :`,
      transferRes.getValue()
    );
    const receivedTransfer = await event;
    console.log(
      `Received transfer ${JSON.stringify(
        receivedTransfer.transfer
      )}, resolving...`
    );
    const resolveRes = await this.connextClient.resolveTransfer({
      channelAddress: receiverChannelState.channelAddress,
      transferResolver: {
        preImage: preImage,
      },
      transferId: receivedTransfer.transfer.transferId,
    });
    if (resolveRes.isError) {
      throw new Error(`Error resolving transfer: ${resolveRes.getError()}`);
    }

    console.log(`Successfully resolved transfer:, `, resolveRes.getValue());
    await this.updateChannel(senderChannelState.channelAddress);
    await this.updateChannel(receiverChannelState.channelAddress);
  }

  async withdraw(
    receiverChainId: number,
    assetId: string,
    recipient: string,
    value: string
  ) {
    await this.basicSanitation({
      toChainId: receiverChainId,
      fromAssetId: assetId,
      value: value,
      withdrawalAddress: recipient,
    });

    const amount = ethers.utils.parseEther(value).toString();

    const channelState = await this.getChannelByParticipants(
      this.config.publicIdentifier,
      this.counterparty,
      receiverChainId
    );

    const requestRes = await this.connextClient.withdraw({
      channelAddress: channelState.channelAddress,
      assetId,
      amount,
      recipient,
    });
    if (requestRes.isError) {
      throw new Error(`Error withdrawing: ${requestRes.getError()}`);
    }
    console.log(`Successfully withdraw: `, requestRes.getValue());

    await this.updateChannel(channelState.channelAddress);
  }

  async crossTransfer(
    value: string,
    fromChainId: number,
    fromAssetId: string,
    toChainId: number,
    toAssetId: string,
    withdrawalAddress?: string
  ) {
    await this.basicSanitation({
      fromChainId: fromChainId,
      fromAssetId: fromAssetId,
      toChainId: toChainId,
      toAssetId: toAssetId,
      value: value,
      withdrawalAddress: withdrawalAddress,
    });

    const amount = ethers.utils.parseEther(value).toString();

    const params = {
      amount,
      fromChainId,
      fromAssetId,
      toChainId,
      toAssetId,
      withdrawalAddress,
    };
    try {
      await this.connextClient.crossChainTransfer(params);
    } catch (e) {
      throw new Error(`Error crossChainTransfer: ${e}`);
    }
    console.log("CrossChain transfer is Successfull");
  }

  async send(
    senderChainId: number,
    senderAssetId: string,
    receiverChainId: number,
    receiverAddress: string,
    amount: string
  ) {
    await this.deposit(senderChainId, senderAssetId, amount);
    await this.transfer(senderChainId, senderAssetId, amount, receiverChainId);
    await this.withdraw(
      receiverChainId,
      senderAssetId,
      receiverAddress,
      amount
    );
    console.log("Successfully Sent");
  }

  /* ------------------------------------------------------------ */
  // functions below are not being used

  async checkAndSetupChannel() {
    ENVIRONMENT.map(async (t) => {
      let channelState = await this.getChannelByParticipants(
        this.config.publicIdentifier,
        this.counterparty,
        t.chainId
      );

      if (!channelState) {
        try {
          console.log(
            `No channel detected for chainId ${t.chainId}, setting up channel...`
          );
          await this.setupChannel(this.counterparty, t.chainId);
          channelState = await this.getChannelByParticipants(
            this.config.publicIdentifier,
            this.counterparty,
            t.chainId
          );
        } catch (e) {
          console.error(`Error setting up channel for chainId ${t.chainId}`);
        }
      }
      console.log(`Channel for chainId ${t.chainId}: `, channelState);
    });
  }

  async setupChannel(aliceIdentifier: string, chainId: number) {
    const setupRes = await this.connextClient.setup({
      counterpartyIdentifier: aliceIdentifier,
      chainId: chainId,
      timeout: DEFAULT_CHANNEL_TIMEOUT.toString(),
    });
    if (setupRes.isError) {
      console.error(`Error setting up channel: ${setupRes.getError()}`);
      return;
    }
    console.log(`Setup Channel for Chain: ${chainId} :`, setupRes.getValue());
  }
}

export const connext = new Connext();

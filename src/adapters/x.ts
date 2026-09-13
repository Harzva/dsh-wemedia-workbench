import { ChannelBridgeAdapter } from "./channelBridge.ts";
import type { ChannelBridgeOptions } from "./channelBridge.ts";

export class XAdapter extends ChannelBridgeAdapter {
  constructor(options: ChannelBridgeOptions) { super("x", options); }
}

import { ChannelBridgeAdapter } from "./channelBridge.ts";
import type { ChannelBridgeOptions } from "./channelBridge.ts";

/** Local preparation and the existing account's Xiaohongshu MCP protocol. */
export class XiaohongshuAdapter extends ChannelBridgeAdapter {
  constructor(options: ChannelBridgeOptions) { super("xiaohongshu", options); }
}

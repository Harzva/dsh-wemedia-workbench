import { ChannelBridgeAdapter } from "./channelBridge.ts";
import type { ChannelBridgeOptions } from "./channelBridge.ts";

/** Reuse the existing local browser account through the independent Zhihu bridge. */
export class ZhihuAdapter extends ChannelBridgeAdapter {
  constructor(options: ChannelBridgeOptions) { super("zhihu", options); }
}

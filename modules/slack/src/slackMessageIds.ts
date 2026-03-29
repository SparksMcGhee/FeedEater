import { SLACK_MESSAGE_BUS_UUID_NAMESPACE } from "@feedeater/core";
import { v5 as uuidv5 } from "uuid";

export function slackSourceIdToBusMessageId(sourceId: string): string {
  return uuidv5(sourceId, SLACK_MESSAGE_BUS_UUID_NAMESPACE);
}

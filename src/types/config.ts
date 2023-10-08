export interface Config {
  telegram: {
    GroupId: number;
    postBotToken: string;
    syncBotToken: string;
  };
  discourse: {
    url: string;
    channelId: number;
    "Api-Username": string;
    "Api-Key": string;
  };
}

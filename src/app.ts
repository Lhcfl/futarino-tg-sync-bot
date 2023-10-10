import DiscourseApi from "node-discourse-api";
import TelegramBot, {
  ChatJoinRequest,
  InputMedia,
  Message,
} from "node-telegram-bot-api";
import fs from "fs";
import crypto from "node:crypto";
import yaml from "js-yaml";
import { Config } from "@/types/config";
import TgCooked from "@/lib/tgcooked";
import { Post, Topic } from "node-discourse-api/lib/types/discourse";
import DB from "./lib/db";
import plain2html from "./lib/plain2html";

// load config
const config: Config = yaml.load(
  fs.readFileSync("./config.yml").toString(),
) as Config;
console.log(config);

const discourse = new DiscourseApi(config.discourse.url);
discourse.options.api_key = config.discourse["Api-Key"];
discourse.options.api_username = config.discourse["Api-Username"];
discourse.webhook.registWebhookPath("/sandbox_post");
discourse.webhook.registWebhookPath("/chat");

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: "pkcs1",
    format: "pem",
  },
  privateKeyEncoding: {
    type: "pkcs1",
    format: "pem",
  },
});

function errString(err: unknown) {
  if (typeof err === "object") {
    if (err && "status" in err && "statusText" in err && "body" in err) {
      let str = `${err.status} ${err.statusText}`;
      if (typeof err.body === "object" && err.body && "errors" in err.body) {
        if (Array.isArray(err.body.errors)) {
          str += `: ${err.body.errors.join(";")}`;
        } else {
          str += `: ${JSON.stringify(err.body.errors)}`;
        }
      } else {
        return str;
      }
    }
  }
  return JSON.stringify(err);
}

discourse.webhook.app.get("/login", (req, res) => {
  if (req.query.payload) {
    const need = discourse.decryptUserApiKey(
      privateKey,
      req.query.payload as string,
    );
    const uid = getUserByNonce[need.nonce].uid;
    if (uid) {
      getFutaApiKeyByTgSenderId[uid] = need.key;
      bot.sendMessage(
        getUserByNonce[need.nonce].chatId,
        "登录成功！ 使用 /logout 退出登录",
      );
      if (getJoinRequestByUserChatId[getUserByNonce[need.nonce].chatId]) {
        bot.sendMessage(
          getUserByNonce[need.nonce].chatId,
          "请等待我们验证身份……",
        );
        const userApi = new DiscourseApi(config.discourse.url);
        userApi.options.user_api_key = getFutaApiKeyByTgSenderId[uid];
        userApi.chat
          .sendMessage(config.discourse.channelId, "(Request to join telegram group)")
          .then(() => {
            bot.sendMessage(getUserByNonce[need.nonce].chatId, "验证成功！");
            bot.approveChatJoinRequest(
              config.telegram.GroupId,
              getJoinRequestByUserChatId[getUserByNonce[need.nonce].chatId].from
                .id,
            );
          })
          .catch((err) => {
            bot.sendMessage(
              getUserByNonce[need.nonce].chatId,
              `验证身份失败！下面是信息：\n${JSON.stringify(err)}`,
            );
          });
      }
    }
  }
  res.status(200).json({ message: "ok" });
});

discourse.webhook.startWebhook(50055).then(() => {
  console.log("Webhook started.");
});

// The bot to sync posts
const bot = new TelegramBot(config.telegram.postBotToken, {
  polling: {
    interval: 2000,
  },
  // webhook: true,
});

// The bot to sync chat
const syncbot = new TelegramBot(config.telegram.syncBotToken, {
  polling: {
    interval: 2000,
  },
  // webhook: true,
});

const botSettings = {
  hideSenderUsernameAutomately: true,
  reply: true,
  sync: false,
  shutUp: false,
};

const db = new DB();

const getFutaPostByTgMessageId = db.defineDataBase<{
  post_number?: number;
  topic_id: number;
}>("getFutaPostByTgMessageId");

const getTgMessageIdByFutaPostId = db.defineDataBase<number>(
  "getTgMessageIdByFutaPostId",
);

const getForwardedFutaPostIdByTgMessageId = db.defineDataBase<number>(
  "getForwardedFutaPostIdByTgMessageId",
);

const hasTitleTgMessageId = db.defineDataBase<boolean>("hasTitleTgMessageId");

const hasTitleFutaMessageId = db.defineDataBase<boolean>(
  "hasTitleFutaMessageId",
);

const getFutaMessageIdByTg = db.defineDataBase<number>("getFutaMessageIdByTg");

const getTgMessageIdByFuta = db.defineDataBase<number>("getTgMessageIdByFuta");

const getFutaApiKeyByTgSenderId = db.defineDataBase<string>(
  "getFutaApiKeyByTgSenderId",
  {
    saveInSeconds: 0,
    autoDeleteInSecond: -1,
  },
);

const getUserByNonce = db.defineDataBase<{
  uid: number;
  chatId: number;
}>("getUserByNonce", {
  saveInSeconds: 0,
  autoDeleteInSecond: -1,
});

const getJoinRequestByUserChatId = db.defineDataBase<ChatJoinRequest>(
  "getJoinRequestByUserChatId",
);

const message_ids_not_need_sync_to_tg = db.defineDataBase<boolean>(
  "message_ids_not_need_sync_to_tg",
);

let lastreply: string | number = "";

function normalUrl(url: string) {
  if (url.startsWith("/")) url = config.discourse.url + url;
  return url;
}

function getDiscourseApi(uid: number) {
  if (getFutaApiKeyByTgSenderId[uid]) {
    const userApi = new DiscourseApi(config.discourse.url);
    userApi.options.user_api_key = getFutaApiKeyByTgSenderId[uid];
    return userApi;
  } else {
    return discourse;
  }
}

discourse.webhook.on("chat_message", async (body, res) => {
  if (body.message.user.username === "FutaTelegramBot") {
    res.json({ text: "200 ok", ec: 200 });
    return;
  }

  if (!botSettings.sync) {
    res.json({ text: "200 ok", ec: 200 });
    return;
  }

  if (body.channel.slug === "authened") {
    // await to load message_ids_not_need_sync_to_tg
    await new Promise((res) => setTimeout(() => res(null), 100));

    if (message_ids_not_need_sync_to_tg[body.message.id]) {
      console.log("这条消息不需要转发");
      delete message_ids_not_need_sync_to_tg[body.message.id];
      res.json({ text: "200 ok", ec: 200 });
      return;
    }

    if (body.message.deleted_at) {
      if (getTgMessageIdByFuta[body.message.id]) {
        syncbot.deleteMessage(
          config.telegram.GroupId,
          getTgMessageIdByFuta[body.message.id],
        );
      }
      res.json({ text: "200 ok", ec: 200 });
      return;
    }

    let b_cooked = body.message.cooked;

    b_cooked = b_cooked.replaceAll(
      /<aside class="onebox[^>]*?data-onebox-src="([^"]+)"[^>]*>[\s\S]+?<\/aside>/g,
      "",
    );

    let urls: readonly InputMedia[] = (b_cooked.match(/<img src="([^"]+)"/g) || []).map((url) => {
      if (url.startsWith("/")) url = config.discourse.url + url;
      return {
        type: "photo",
        media: url,
      };
    });

    if (body.message.uploads) {
      urls = urls.concat(
        body.message.uploads.map((upload: { url: string }) => {
          const url = normalUrl(upload.url);

          console.log("检测到文件：" + url);
          return {
            type: "photo",
            media: url,
          };
        }),
      );
    }

    let caption;
    if (
      body.message.user.username === lastreply &&
      !body.message.in_reply_to &&
      !hasTitleFutaMessageId[body.message.id]
    ) {
      caption = TgCooked(body.message.cooked, { strip_emoji: false }).trim();
    } else {
      caption =
        `<b>${plain2html(body.message.user.username)}</b>:\n` +
        TgCooked(body.message.cooked, { strip_emoji: false }).trim();
      hasTitleFutaMessageId[body.message.id] = true;
    }

    lastreply = body.message.user.username;

    if (urls.length == 0) {
      if (getTgMessageIdByFuta[body.message.id]) {
        syncbot.editMessageText(caption, {
          chat_id: config.telegram.GroupId,
          message_id: getTgMessageIdByFuta[body.message.id],
          parse_mode: "HTML",
        });
      } else {
        syncbot
          .sendMessage(config.telegram.GroupId, caption, {
            parse_mode: "HTML",
            reply_to_message_id:
              body.message.in_reply_to &&
              getTgMessageIdByFuta[body.message.in_reply_to.id],
          })
          .then((res) => {
            // console.log(res);
            getTgMessageIdByFuta[body.message.id] = res.message_id;
            getFutaMessageIdByTg[res.message_id] = body.message.id;
          });
      }
    } else if (urls.length == 1) {
      if (getTgMessageIdByFuta[body.message.id]) {
        syncbot.editMessageCaption(caption, {
          chat_id: config.telegram.GroupId,
          message_id: getTgMessageIdByFuta[body.message.id],
          parse_mode: "HTML",
        });
      } else {
        syncbot
          .sendPhoto(config.telegram.GroupId, urls[0].media, {
            caption,
            parse_mode: "HTML",
            reply_to_message_id:
              body.message.in_reply_to &&
              getTgMessageIdByFuta[body.message.in_reply_to.id],
          })
          .then((res) => {
            // console.log(res);
            getTgMessageIdByFuta[body.message.id] = res.message_id;
            getFutaMessageIdByTg[res.message_id] = body.message.id;
          });
      }
    } else {
      if (getTgMessageIdByFuta[body.message.id]) {
        syncbot.editMessageText(
          `<b>${plain2html(body.message.user.username)} in ${plain2html(body.channel.title)} </b>\n` +
            TgCooked(body.message.cooked, { strip_emoji: false }).trim(),
          {
            chat_id: config.telegram.GroupId,
            message_id: getTgMessageIdByFuta[body.message.id],
            parse_mode: "HTML",
          },
        );
      } else {
        syncbot
          .sendMessage(
            config.telegram.GroupId,
            `<b>${plain2html(body.message.user.username)} in ${plain2html(body.channel.title)} </b>\n` +
              TgCooked(body.message.cooked, { strip_emoji: false }).trim(),
            {
              parse_mode: "HTML",
              reply_to_message_id:
                body.message.in_reply_to &&
                getTgMessageIdByFuta[body.message.in_reply_to.id],
            },
          )
          .then((res) => {
            // console.log(res);
            getTgMessageIdByFuta[body.message.id] = res.message_id;
            getFutaMessageIdByTg[res.message_id] = body.message.id;
          });
        for (let i = 0; i < urls.length; i += 10) {
          syncbot
            .sendMediaGroup(config.telegram.GroupId, urls.slice(i, i + 10))
            .then((res) => {
              // console.log(res);
              getFutaMessageIdByTg[res.message_id] = body.message.id;
            });
        }
      }
    }
  }

  res.json({ text: "200 ok", ec: 200 });
});

discourse.webhook.on("post", (body, res) => {
  if (!botSettings.reply) {
    res.json({ text: "200 ok", ec: 200 });
    return;
  }

  function mkpst(res: Message) {
    getFutaPostByTgMessageId[res.message_id] = {
      post_number: body.post_number,
      topic_id: body.topic_id,
    };
  }

  let cooked = body.cooked;

  const tgckd = TgCooked(cooked);

  cooked =
    `<b>${plain2html(body.username)} 在 <a href="${config.discourse.url}/t/-/${body.topic_id}/${body.post_number}">${plain2html(body.topic_title)}</a> 中发帖：</b>\n` +
    tgckd;

  if (!getTgMessageIdByFutaPostId[body.id]) {
    let b_cooked = body.cooked;

    b_cooked = b_cooked.replaceAll(
      /<aside class="onebox[^>]*?data-onebox-src="([^"]+)"[^>]*>[\s\S]+?<\/aside>/g,
      "",
    );
    b_cooked = b_cooked.replaceAll(/<img src="\/images\/emoji[^>]*?/g, "");

    const urls: InputMedia[] = Array.from(
      b_cooked.matchAll(/<img src="([^"]+)"/g),
    ).map((matchedImg) => {
      const url = matchedImg[1];
      return {
        type: "photo",
        media: normalUrl(url),
      };
    });

    if (!(urls.length !== 0 || tgckd.trim())) {
      return;
    }

    bot
      .sendMessage(config.telegram.GroupId, cooked, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      })
      .then((res) => {
        // console.log(res);
        mkpst(res);
        getTgMessageIdByFutaPostId[body.id] = res.message_id;
      });

    if (urls.length < 2) {
      urls.forEach((media) => {
        bot.sendPhoto(config.telegram.GroupId, media.media).then((res) => {
          // console.log(res);
          mkpst(res);
        });
      });
    } else {
      for (let i = 0; i < urls.length; i += 10) {
        bot
          .sendMediaGroup(config.telegram.GroupId, urls.slice(i, i + 10))
          .then((res) => {
            // console.log(res);
            mkpst(res);
          });
      }
    }
  } else {
    bot
      .editMessageText(cooked, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        chat_id: config.telegram.GroupId,
        message_id: getTgMessageIdByFutaPostId[body.id],
      })
      .then((res) => {
        // console.log(res);
        if (typeof res === "object") {
          mkpst(res);
          getTgMessageIdByFutaPostId[body.id] = res.message_id;
        }
      });
  }

  res.json({ text: "200 ok", ec: 200 });
});

async function renderMsgText(msg: Message, post = false) {
  msg.text = msg.text || msg.caption || "";
  if (msg.sticker) {
    const sticker = msg.sticker;
    sticker.set_name = sticker.set_name || "";
    sticker.emoji = sticker.emoji || "";
    const lnk = await bot.getFileLink(msg.sticker.file_id);
    console.log("get sticker link: " + lnk);
    if (post) {
      if (lnk.includes("webm")) {
        msg.text += `\n![sticker|video](${lnk})`;
      } else if (lnk.includes("tgs")) {
        msg.text += `[sticker ${sticker.set_name} ${sticker.emoji}]`;
      } else {
        msg.text += `\n![sticker](${lnk})`;
      }
    } else {
      if (lnk.includes("webm")) {
        msg.text += `[（Telegram Sticker）](${lnk})${sticker.emoji}`;
      } else if (lnk.includes("tgs")) {
        msg.text += `[sticker]${sticker.emoji}`;
      } else {
        msg.text += `\n![sticker](${lnk})`;
      }
    }
  }
  if (msg.photo) {
    const lnk = await bot.getFileLink(msg.photo[msg.photo.length - 1].file_id);
    console.log("get photo link: " + lnk);
    if (post) {
      if (lnk.includes("webm")) {
        msg.text += `\n![sticker|video](${lnk})`;
      } else {
        msg.text += `\n![sticker](${lnk})`;
      }
    } else {
      if (lnk.includes("webm")) {
        msg.text += `\n![sticker|video](${lnk})`;
      } else {
        msg.text += `\n![photo](${lnk})`;
      }
    }
  }
  if (msg.video) {
    console.log(msg.video);
    msg.text += "\n[video] 本版本转发bot暂不支持转发视频>_<";
  }
}

// Listen for any kind of message. There are different kinds of
// messages.

let nextUrl = "/latest";

async function handleTgMessage(msg: Message) {
  const chatId = msg.chat.id;
  if (!msg.from) return;
  if (getJoinRequestByUserChatId[chatId]) {
    const joinRequest = getJoinRequestByUserChatId[chatId]; 
    try {
      bot.sendMessage(
        config.telegram.GroupId,
        `新的等待加群的用户： @${
          joinRequest.from.username || joinRequest.from.first_name
        }\n发送的信息： ${msg.text}`,
      );
      bot.sendMessage(chatId, "好的，接下来请等待群主审核~");
    } catch (err) {
      bot.sendMessage(
        config.telegram.GroupId,
        `有一名新用户 @${
          joinRequest.from.username || joinRequest.from.first_name
        } 试图加入本群，但是发生了错误， @Lhc_fl 快去看日志`,
      );
      bot.sendMessage(
        chatId,
        `诶呀，出现了错误：${JSON.stringify(
          err,
        )}\n我已经报告了该错误，请等待群主审核🥺`,
      );
    }
  }
  if (chatId != config.telegram.GroupId) {
    return;
  }
  // console.log(msg);
  try {
    if (
      msg.text &&
      (msg.text.startsWith("/latest") || msg.text.startsWith("/next"))
    ) {
      if (msg.text.startsWith("/latest")) {
        nextUrl = "/latest";
      }
      const latest = await discourse._request(nextUrl);
      const topic_list = latest.topic_list;
      nextUrl = topic_list.more_topics_url;
      if (topic_list && topic_list.topics) {
        bot.sendMessage(
          chatId,
          "按命令即可回复哦~\n" +
            topic_list.topics
              .filter(
                (t: Topic) =>
                  t.category_id == 4 ||
                  t.category_id == 6 ||
                  t.category_id == 9,
              )
              .map((t: Topic) => `/replyto_${t.id} ${t.title}`)
              .join("\n") +
            "\n/next 下一页",
        );
      }
      return;
    }

    if (msg.text && msg.text.startsWith("/replyto")) {
      const matched = /^\/replyto_([0-9]+)[\S]*\s*([\s\S]*)/.exec(msg.text);
      console.log(matched);
      if (!matched) {
        bot.sendMessage(chatId, "命令格式不对哦", {
          reply_to_message_id: msg.message_id,
        });
        return;
      } else if (!matched[2]) {
        let msg_to_send = "";

        const topic = await discourse.getTopicInfo(matched[1], {
          arround_post_number: "last"
        });

        msg_to_send += `<a href="${config.discourse.url}/t/-/${topic.id}">${plain2html(topic.title)}</a> 的最新帖子：\n-------------\n`;
        const posts =
          topic?.post_stream?.posts && topic?.post_stream?.posts.slice(-3);

        if (posts) {
          msg_to_send += posts
            .map(
              (p: Post) =>
                `<b>${plain2html(p.username)}</b>：\n${TgCooked(p.cooked).trim()}`,
            )
            .join("\n------------\n");
        }

        bot
          .sendMessage(
            chatId,
            msg_to_send + "\n------------\n回复我在此楼中发布新消息：",
            {
              reply_to_message_id: msg.message_id,
              parse_mode: "HTML",
              disable_web_page_preview: true,
            },
          )
          .then((res) => {
            getFutaPostByTgMessageId[res.message_id] = {
              topic_id: Number(matched[1]),
            };
          });
        return;
      } else {
        msg.reply_to_message = {
          message_id: msg.message_id,
          date: Number(new Date()),
          chat: {
            id: chatId,
            type: "group",
          },
        };
        getFutaPostByTgMessageId[msg.message_id] = {
          topic_id: Number(matched[1]),
        };
        msg.text = matched[2];

        // NO return here
      }
    }

    if (msg.reply_to_message) {
      const mid = msg.reply_to_message.message_id;
      const post = getFutaPostByTgMessageId[mid];
      if (post && botSettings.reply) {
        await renderMsgText(msg, true);

        if (!msg.text) {
          bot.sendMessage(chatId, "检测不到正文。", {
            reply_to_message_id: msg.message_id,
          });
          return;
        }

        const raw = getFutaApiKeyByTgSenderId[msg.from.id]
          ? msg.text.trim()
          : `**${
            msg.from?.first_name || msg.from?.username
          } 在 Telegram 中回复您：**\n${msg.text.trim()}`;

        getDiscourseApi(msg.from.id)
          .createTopicPostPM({
            topic_id: post.topic_id,
            reply_to_post_number: post.post_number,
            raw,
          })
          .then((res) => {
            console.log(res);
            getForwardedFutaPostIdByTgMessageId[msg.message_id] = res.id;
          })
          .catch((err) => {
            bot.sendMessage(chatId, errString(err), {
              reply_to_message_id: msg.message_id,
            });
          });
      } else {
        if (msg.text == "shut up") {
          botSettings.shutUp = true;
        }
        if (
          msg.reply_to_message &&
          msg.reply_to_message.from?.username == "FutarinoBot" &&
          !botSettings.shutUp
        ) {
          bot.sendMessage(
            chatId,
            "找不到源帖子。这可能是因为该数据被清理或者本测试bot被重启。",
            {
              reply_to_message_id: msg.message_id,
            },
          );
        }
      }
    }
  } catch (err) {
    bot.sendMessage(chatId, errString(err));
    console.error(err);
  }
}

bot.on("message", handleTgMessage);

syncbot.on("edited_message", async (msg) => {
  const chatId = msg.chat.id;
  console.log(msg);
  if (!msg.from) return;
  try {
    if (getForwardedFutaPostIdByTgMessageId[msg.message_id]) {
      await renderMsgText(msg, true);
      if (!msg.text) {
        bot.sendMessage(chatId, "检测不到正文。", {
          reply_to_message_id: msg.message_id,
        });
        return;
      }
      const raw = getFutaApiKeyByTgSenderId[msg.from.id]
        ? msg.text.trim()
        : `**${
          msg.from?.first_name || msg.from?.username
        } 在 Telegram 中回复您：**\n${msg.text.trim()}`;

      getDiscourseApi(msg.from.id)
        .updatePost(getForwardedFutaPostIdByTgMessageId[msg.message_id], {
          raw,
        })
        .then((res) => {
          console.log(res);
        })
        .catch((err) => {
          bot.sendMessage(
            chatId,
            `尝试编辑时发生了错误： ${JSON.stringify(err)}`,
            {
              reply_to_message_id: msg.message_id,
            },
          );
        });

      return;
    }
    if (getFutaMessageIdByTg[msg.message_id]) {
      await renderMsgText(msg);

      if (!msg.text) {
        return;
      }
      let raw = msg.text;

      if (hasTitleTgMessageId[msg.message_id]) {
        raw = `**${
          msg.from?.first_name || msg.from?.username
        } in Telegram ：**\n${msg.text}`;
      }

      const msgres = await getDiscourseApi(msg.from.id).chat.editMessage(
        config.discourse.channelId,
        getFutaMessageIdByTg[msg.message_id],
        raw,
      );

      message_ids_not_need_sync_to_tg[msgres.message_id] = true;
    }
  } catch (err) {
    console.log(err);
  }
});

syncbot.on("message", async (msg) => {
  if (!msg.from) return;
  if (!botSettings.sync) {
    lastreply = -1;
    return;
  }
  if (msg.text && msg.text.startsWith("/")) {
    lastreply = -1;
    return;
  }
  if (
    msg?.reply_to_message?.from?.username !== "FutaSyncBot" &&
    msg?.reply_to_message?.from?.is_bot
  ) {
    lastreply = -1;
    return;
  }
  const chatId = msg.chat.id;

  if (chatId != config.telegram.GroupId) {
    console.log(`receiving ${chatId}, not ${config.telegram.GroupId}, return`);
    return;
  }
  console.log(msg);
  try {
    const mid = msg.reply_to_message?.message_id;

    await renderMsgText(msg);

    if (!msg.text) {
      return;
    }

    let msgres;
    let raw;
    let hasTitle = false;

    if (getFutaApiKeyByTgSenderId[msg.from?.id]) {
      raw = msg.text;
    } else if (lastreply === msg.from?.id && !msg.reply_to_message) {
      raw = msg.text;
    } else {
      raw = `**${
        msg.from?.first_name || msg.from?.username
      } in Telegram ：**\n${msg.text}`;
      hasTitle = true;
    }

    console.log(
      `mid is ${mid} && getFutaMessageIdByTg[mid] is ${
        mid && getFutaMessageIdByTg[mid]
      }`,
    );

    if (getFutaApiKeyByTgSenderId[msg.from.id]) {
      msgres = await getDiscourseApi(msg.from.id).chat.sendMessage(config.discourse.channelId, raw, {
        in_reply_to_id: mid && getFutaMessageIdByTg[mid],
      });
      message_ids_not_need_sync_to_tg[msgres.message_id] = true;
    } else {
      msgres = await discourse.chat.sendMessage(config.discourse.channelId, raw, {
        in_reply_to_id: mid && getFutaMessageIdByTg[mid],
      });
    }

    lastreply = msg.from?.id;

    console.log("msgres: ");
    console.log(msgres);

    getFutaMessageIdByTg[msg.message_id] = msgres?.message_id;
    getTgMessageIdByFuta[msgres?.message_id] = msg.message_id;

    if (hasTitle) {
      hasTitleTgMessageId[msg.message_id] = msgres?.message_id;
    }
  } catch (err) {
    syncbot.sendMessage(chatId, errString(err));
  }
});

bot.on("chat_join_request", async (joinRequest) => {
  if (joinRequest.chat.id != config.telegram.GroupId) {
    return;
  }
  bot.sendMessage(
    joinRequest.user_chat_id,
    "诶嘿，欢迎加入某半跑路的扶她林讨论群组！为了防止Spam，本群需要和Futarino账号绑定（或者让我认识认识你）。\n\n你可以向我使用 /login 来登录Futarino账户，这样我会自动批准你加入群聊。或者，你也可以试试直接回复我你的 Futarino 用户名（或者你想加入的原因也行！），我会把它发送给群主，由群主来审核加入。",
  );
  getJoinRequestByUserChatId[joinRequest.user_chat_id] = joinRequest;

  if (getFutaApiKeyByTgSenderId[joinRequest.from.id]) {
    bot.sendMessage(
      joinRequest.user_chat_id,
      "已检测你登录了Futarino！请等待我们验证身份……",
    );
    const userApi = new DiscourseApi(config.discourse.url);
    userApi.options.user_api_key =
      getFutaApiKeyByTgSenderId[joinRequest.from.id];
    userApi.chat
      .sendMessage(config.discourse.channelId, "(Request to join telegram group)")
      .then(() => {
        bot.approveChatJoinRequest(
          config.telegram.GroupId,
          joinRequest.from.id,
        );
      })
      .catch((err) => {
        bot.sendMessage(
          joinRequest.user_chat_id,
          `验证身份失败！下面是信息：\n${JSON.stringify(err)}`,
        );
      });
  }
});

bot.onText(/\/id/, (msg) => {
  const chat = msg.chat;
  bot.sendMessage(chat.id, `chat id is ${chat.id}`);
});
bot.onText(/\/login/, (msg) => {
  const chatId = msg.chat.id;
  if (!msg.from) return;
  if (msg.chat.type === "private") {
    if (!getFutaApiKeyByTgSenderId[msg.from.id]) {
      try {
        const u = discourse.generateUserApiKeySync({
          application_name: "FutaTelegramBot",
          client_id: "futa_tg_bot_" + crypto.randomBytes(8).toString("hex"),
          auth_redirect: "https://api.futarino.online/login",
          public_key: publicKey,
          scopes: "read,write",
        });
        getUserByNonce[u.nonce] = {
          uid: msg.from.id,
          chatId: chatId,
        };
        bot.sendMessage(
          chatId,
          "请点击该链接授权bot登录你的futarino账户……\n" + u.url,
        );
      } catch (err) {
        bot.sendMessage(chatId, errString(err));
      }
    } else {
      if (getJoinRequestByUserChatId[msg.chat.id]) {
        bot.sendMessage(msg.chat.id, "已检测你登录了！请等待我们验证身份……");
        const userApi = new DiscourseApi(config.discourse.url);
        userApi.options.user_api_key = getFutaApiKeyByTgSenderId[msg.from.id];
        userApi.chat
          .sendMessage(config.discourse.channelId, "(Request to join telegram group)")
          .then(() => {
            bot.approveChatJoinRequest(
              config.telegram.GroupId,
              getJoinRequestByUserChatId[msg.chat.id].from.id,
            );
          })
          .catch((err) => {
            bot.sendMessage(
              msg.chat.id,
              `验证身份失败！下面是信息：\n${JSON.stringify(err)}`,
            );
          });
      } else {
        bot.sendMessage(chatId, "你已经登录过了！发送 /logout 退出");
      }
    }
  } else {
    bot.sendMessage(chatId, "请私信我");
  }
});
bot.onText(/\/logout/, (msg) => {
  if (!msg.from) return;
  const chatId = msg.chat.id;
  if (msg.chat.type === "private") {
    if (getFutaApiKeyByTgSenderId[msg.from.id]) {
      discourse
        .revokeUserApiKey(getFutaApiKeyByTgSenderId[msg.from.id])
        .catch((err) => {
          bot.sendMessage(
            chatId,
            "清除登录token失败，可能是因为你尚未登录导致。ERR info: " +
              JSON.stringify(err),
          );
        });
      delete getFutaApiKeyByTgSenderId[msg.from.id];
    }
    bot.sendMessage(chatId, "已清除登录token");
  } else {
    bot.sendMessage(chatId, "请私信我");
  }
});
bot.onText(/\/speak/, (msg) => {
  const chat = msg.chat;
  bot.sendMessage(chat.id, "爷回来辣！");
  botSettings.shutUp = false;
});
bot.onText(/\/toggle_push/, (msg) => {
  if (msg.chat.id == config.telegram.GroupId) {
    const chat = msg.chat;
    botSettings.reply = !botSettings.reply;
    bot.sendMessage(
      chat.id,
      `已${botSettings.reply ? "开启" : "关闭"}Futarino推送。`,
    );
  } else {
    bot.sendMessage(msg.chat.id, "该命令只在对应群聊中生效。");
  }
});

syncbot.onText(/\/toggle_sync/, (msg) => {
  const chat = msg.chat;
  botSettings.sync = !botSettings.sync;
  syncbot.sendMessage(
    chat.id,
    `已${botSettings.sync ? "开启" : "关闭"}天空岛同步。`,
  );
});
syncbot.onText(/\/sync_on/, (msg) => {
  const chat = msg.chat;
  botSettings.sync = true;
  syncbot.sendMessage(
    chat.id,
    `已${botSettings.sync ? "开启" : "关闭"}天空岛同步。`,
  );
});
syncbot.onText(/\/sync_off/, (msg) => {
  const chat = msg.chat;
  botSettings.sync = false;
  syncbot.sendMessage(
    chat.id,
    `已${botSettings.sync ? "开启" : "关闭"}天空岛同步。`,
  );
});

syncbot.onText(/\/is_sync/, (msg) => {
  const chat = msg.chat;
  syncbot.sendMessage(
    chat.id,
    `同步功能${botSettings.sync ? "开启" : "关闭"}中。`,
  );
});

syncbot.setMyCommands([
  {
    command: "toggle_sync",
    description: "开关同步",
  },
  {
    command: "sync_on",
    description: "开同步",
  },
  {
    command: "sync_off",
    description: "关同步",
  },
  {
    command: "is_sync",
    description: "查询是否正在同步",
  },
]);

bot.setMyCommands([
  {
    command: "login",
    description: "登录",
  },
  {
    command: "logout",
    description: "退出",
  },
  {
    command: "toggle_push",
    description: "开关futa推送功能",
  },
  {
    command: "latest",
    description: "显示首页的帖子！",
  },
]);

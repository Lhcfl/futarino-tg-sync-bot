function replaceEmoji(cooked: string) {
  cooked = cooked.replaceAll(
    /<img src="\/images\/emoji\/[^\/]+\/([^.]+)[^>]*>/g,
    (emojiName) => {
      const emojiMap: {
        [key in string]?: string;
      } = {
        smiling_face_with_three_hearts: "🥰",
        yum: "😋",
        hot_face: "🥵",
      };
      return emojiMap[emojiName] || "[emoji]";
    },
  );
  return cooked;
}

export default function TgCooked(
  cooked: string,
  config: {
    strip_emoji?: boolean;
    max_length?: number;
  } = {
    strip_emoji: true,
    max_length: 3000,
  },
) {
  cooked = cooked.replaceAll("%l%", "(l=[l]=%)");
  cooked = cooked.replaceAll("%r%", "(%=[r]=r)");

  cooked = cooked.replaceAll(
    /<aside class="onebox[^>]*?data-onebox-src="([^"]+)"[^>]*>[\s\S]+?<\/aside>/g,
    "<a href=\"$1\">$1</a>",
  );

  const keep_cooked = (tagList: string[]) => {
    for (const tag of tagList) {
      cooked = cooked.replaceAll(`<${tag}>`, `%l%${tag}%r%`);
      cooked = cooked.replaceAll(`</${tag}>`, `%l%/${tag}%r%`);
    }
  };
  const map_cooked = (tagList: [string, string][]) => {
    for (const [tag1, tag2] of tagList) {
      cooked = cooked.replaceAll(`<${tag1}>`, `%l%${tag2}%r%`);
      cooked = cooked.replaceAll(`</${tag1}>`, `%l%/${tag2}%r%`);
    }
  };

  map_cooked([
    ["h1", "b"],
    ["h2", "b"],
    ["h3", "b"],
    ["aside", "pre"],
  ]);

  keep_cooked([
    "strong",
    "b",
    "i",
    "em",
    "u",
    "ins",
    "s",
    "strike",
    "del",
    "code",
    "pre",
  ]);

  cooked = cooked.replaceAll("<p>", "\n");
  cooked = cooked.replaceAll("</p>", "\n");

  cooked = cooked.replaceAll(/<aside[^>]+>/g, "%l%pre%r%");
  cooked = cooked.replaceAll(/<pre[^>]+>/g, "%l%pre%r%");
  cooked = cooked.replaceAll(/<code[^>]+>/g, "%l%code%r%");

  cooked = cooked.replaceAll(
    /<a href=([^>]+)>([\s\S]+?)<\/a>/g,
    "%l%a href=$1%r%$2%l%/a%r%",
  );

  cooked = cooked.replaceAll(
    /<[a-zA-Z]+ class="spoiler[^>]+>([\s\S]+?)<\/div>/g,
    "%l%tg-spoiler%r%$1%l%/tg-spoiler%r%",
  );

  if (config.strip_emoji) {
    cooked = replaceEmoji(cooked);
    cooked = cooked.replaceAll(/<img src="\/images\/emoji[^>]*>/g, "[emoji]");
  }

  cooked = cooked.replaceAll(
    /<img src="https:\/\/api.telegram.org[^>]*>/g,
    "[tg photo]",
  );

  cooked = cooked.replaceAll(/<img[^>]+class="avatar[^>]+>/g, "RE:");

  cooked = cooked.replaceAll(/<[\s\S]+?>/g, "");

  cooked = cooked.replaceAll("%l%", "<");
  cooked = cooked.replaceAll("%r%", ">");
  cooked = cooked.replaceAll("(l=[l]=%)", "%l%");
  cooked = cooked.replaceAll("(%=[r]=r)", "%r%");
  cooked = cooked.replaceAll(/\n+/g, "\n");

  config.max_length = config.max_length || 3000;

  if (cooked.length > config.max_length) {
    cooked = cooked.replaceAll(/<[\s\S]+?>/g, "");
  }
  if (cooked.length > config.max_length) {
    cooked =
      cooked.slice(0, config.max_length - 20) +
      "……\n（本帖子超出长度限制被截断）";
  }

  return cooked;
}

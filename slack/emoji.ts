// Emoji between the app and Slack: the Slack name of a teammate's avatar, the picture it is posted as, and the
// reaction names (Slack's :+1: and the emoji behind them), with skin tones.
import type { Look } from "./types";

/** Skin tones and variation selectors off, so 👨🏻‍🎨 and 👨‍🎨 find the same Slack emoji. */
const bare = (e: string) => e.replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, "");

/** Slack's names for emoji a teammate might have as its avatar (icon_emoji takes a name, not the emoji). */
const AVATAR_NAMES: Record<string, string> = {
    "🎼": "musical_score", "👤": "bust_in_silhouette", "🤖": "robot_face",
    "🧙": "mage", "🧙‍♂️": "male_mage", "🧙‍♀️": "female_mage",
    "🧑‍🎨": "artist", "👨‍🎨": "male-artist", "👩‍🎨": "female-artist",
    "🧑‍💻": "technologist", "👨‍💻": "male-technologist", "👩‍💻": "female-technologist",
    "🕵️": "sleuth_or_spy", "🕵️‍♂️": "male-detective", "🕵️‍♀️": "female-detective",
    "🧑‍🔬": "scientist", "👨‍🔬": "male-scientist", "👩‍🔬": "female-scientist",
    "🧑‍💼": "office_worker", "👨‍💼": "male-office-worker", "👩‍💼": "female-office-worker",
    "🧑‍🏫": "teacher", "👨‍🏫": "male-teacher", "👩‍🏫": "female-teacher",
    "🧑‍🔧": "mechanic", "👨‍🔧": "male-mechanic", "👩‍🔧": "female-mechanic",
    "🧑‍⚕️": "health_worker", "👨‍⚕️": "male-doctor", "👩‍⚕️": "female-doctor",
    "🧑‍🚀": "astronaut", "👨‍🚀": "male-astronaut", "👩‍🚀": "female-astronaut",
    "🧑‍🍳": "cook", "👨‍🍳": "male-cook", "👩‍🍳": "female-cook",
    "🧑‍⚖️": "judge", "👨‍⚖️": "male-judge", "👩‍⚖️": "female-judge",
    "🧑‍🎤": "singer", "👨‍🎤": "male-singer", "👩‍🎤": "female-singer",
    "🦸": "superhero", "🦸‍♂️": "male_superhero", "🦸‍♀️": "female_superhero",
    "🥷": "ninja", "👷": "construction_worker", "🧝": "elf", "🧚": "fairy", "🧛": "vampire",
    "🧑": "adult", "👨": "man", "👩": "woman", "🧔": "bearded_person", "👦": "boy", "👧": "girl",
    "🐱": "cat", "🐶": "dog", "🦊": "fox_face", "🦉": "owl", "🐼": "panda_face", "🦁": "lion_face", "🐯": "tiger",
    "🐻": "bear", "🐸": "frog", "🐙": "octopus", "🦄": "unicorn_face", "🐝": "bee", "🐢": "turtle",
    "🧠": "brain", "🔍": "mag", "🛠️": "hammer_and_wrench", "📅": "date", "📝": "memo", "💡": "bulb", "🚀": "rocket",
    "⭐": "star", "🔥": "fire", "🎨": "art", "🧪": "test_tube", "📊": "bar_chart", "💼": "briefcase", "🎯": "dart",
    "🧩": "jigsaw", "👻": "ghost", "👽": "alien", "😎": "sunglasses", "🤓": "nerd_face", "🙂": "slightly_smiling_face",
};
const SLACK_EMOJI = new Map(Object.entries(AVATAR_NAMES).map(([emoji, name]) => [bare(emoji), name]));

/** The Slack emoji name for an avatar, when there's one. */
export const slackEmoji = (avatar: string) => SLACK_EMOJI.get(bare(avatar.trim()));

/**
 * Apple's emoji as 64px images, named by their code points (emoji-datasource). An avatar is posted as its picture
 * (icon_url), so it looks as it does in the app, skin tone and all: icon_emoji takes a name, and Slack's names have no
 * skin tone.
 */
const EMOJI_IMAGES = "https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64/";
const EMOJI_LOOKUP_MS = 5_000;
const avatarImages = new Map<string, Promise<string | undefined>>();

/** The image of an avatar emoji, or undefined when the set has none (or it can't be reached right now). */
export function avatarImage(avatar: string): Promise<string | undefined> {
  const a = avatar.trim();
  if (!/\p{Extended_Pictographic}/u.test(a)) return Promise.resolve(undefined);
  let found = avatarImages.get(a);
  if (!found) {
    const hex = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16)).join("-");
    // The set names most emoji fully qualified (with U+FE0F), some without it.
    const names = [...new Set([hex(a), hex(a.replace(/️/g, ""))])];
    found = (async () => {
      let unreachable = false;
      for (const name of names) {
        const url = `${EMOJI_IMAGES}${name}.png`;
        try {
          const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(EMOJI_LOOKUP_MS) });
          if (r.ok) return url;
          if (r.status !== 404) unreachable = true;
        } catch {
          unreachable = true;
        }
      }
      if (unreachable) avatarImages.delete(a); // asked again next time
      return undefined;
    })();
    avatarImages.set(a, found);
  }
  return found;
}

/** The name and avatar a message goes under in Slack: the avatar's picture, else its Slack emoji, else it goes before the name. */
export async function slackLook(look: Look): Promise<Record<string, string>> {
  const image = await avatarImage(look.avatar);
  if (image) return { username: look.name, icon_url: image };
  const icon = slackEmoji(look.avatar);
  return icon ? { username: look.name, icon_emoji: `:${icon}:` } : { username: `${look.avatar} ${look.name}`.trim() };
}

/** The emoji behind Slack's names for the reactions people use most (and the avatars above). */
const REACTION_EMOJI = new Map<string, string>([
  ...Object.entries(AVATAR_NAMES).map(([emoji, name]) => [name, emoji] as [string, string]),
  ...Object.entries({
    "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎", ok_hand: "👌", clap: "👏", raised_hands: "🙌", pray: "🙏",
    muscle: "💪", wave: "👋", point_up: "☝️", point_up_2: "👆", point_down: "👇", point_left: "👈", point_right: "👉",
    crossed_fingers: "🤞", hand_with_index_and_middle_fingers_crossed: "🤞", v: "✌️", handshake: "🤝", open_hands: "👐",
    raised_hand: "✋", hand: "✋", writing_hand: "✍️", eyes: "👀", brain: "🧠",
    heart: "❤️", orange_heart: "🧡", yellow_heart: "💛", green_heart: "💚", blue_heart: "💙", purple_heart: "💜",
    black_heart: "🖤", white_heart: "🤍", broken_heart: "💔", two_hearts: "💕", sparkling_heart: "💖", heart_eyes: "😍",
    smile: "😄", smiley: "😃", grinning: "😀", grin: "😁", laughing: "😆", satisfied: "😆", joy: "😂", rolling_on_the_floor_laughing: "🤣",
    sweat_smile: "😅", blush: "😊", wink: "😉", upside_down_face: "🙃", relieved: "😌", innocent: "😇", star_struck: "🤩",
    "star-struck": "🤩", partying_face: "🥳", hugging_face: "🤗", thinking_face: "🤔", face_with_monocle: "🧐",
    face_with_raised_eyebrow: "🤨", raised_eyebrow: "🤨", neutral_face: "😐", expressionless: "😑", no_mouth: "😶",
    face_with_rolling_eyes: "🙄", smirk: "😏", grimacing: "😬", confused: "😕", worried: "😟", slightly_frowning_face: "🙁",
    disappointed: "😞", pensive: "😔", cry: "😢", sob: "😭", scream: "😱", fearful: "😨", cold_sweat: "😰", sweat: "😓",
    flushed: "😳", exploding_head: "🤯", rage: "😡", angry: "😠", triumph: "😤", sleeping: "😴", sleepy: "😪", mask: "😷",
    zipper_mouth_face: "🤐", shushing_face: "🤫", face_palm: "🤦", facepalm: "🤦", shrug: "🤷", skull: "💀", poop: "💩",
    hankey: "💩", clown_face: "🤡", see_no_evil: "🙈", hear_no_evil: "🙉", speak_no_evil: "🙊",
    "100": "💯", sparkles: "✨", star2: "🌟", dizzy: "💫", zap: "⚡", boom: "💥", collision: "💥", tada: "🎉",
    confetti_ball: "🎊", balloon: "🎈", gift: "🎁", trophy: "🏆", sports_medal: "🏅", first_place_medal: "🥇",
    pencil2: "✏️", pencil: "📝", pushpin: "📌", round_pushpin: "📍", paperclip: "📎", link: "🔗", lock: "🔒", unlock: "🔓",
    key: "🔑", wrench: "🔧", hammer: "🔨", gear: "⚙️", bug: "🐛", chart_with_upwards_trend: "📈",
    chart_with_downwards_trend: "📉", calendar: "📆", spiral_calendar_pad: "🗓️", alarm_clock: "⏰", hourglass: "⌛",
    hourglass_flowing_sand: "⏳", stopwatch: "⏱️", white_check_mark: "✅", heavy_check_mark: "✔️", ballot_box_with_check: "☑️",
    x: "❌", heavy_multiplication_x: "✖️", negative_squared_cross_mark: "❎", warning: "⚠️", no_entry: "⛔",
    no_entry_sign: "🚫", octagonal_sign: "🛑", stop_sign: "🛑", exclamation: "❗", heavy_exclamation_mark: "❗",
    question: "❓", grey_question: "❔", grey_exclamation: "❕", bangbang: "‼️", interrobang: "⁉️", heavy_plus_sign: "➕",
    heavy_minus_sign: "➖", arrow_up: "⬆️", arrow_down: "⬇️", arrow_right: "➡️", arrow_left: "⬅️", arrows_counterclockwise: "🔄",
    repeat: "🔁", recycle: "♻️", red_circle: "🔴", large_orange_circle: "🟠", large_yellow_circle: "🟡",
    large_green_circle: "🟢", large_blue_circle: "🔵", large_purple_circle: "🟣", white_circle: "⚪", black_circle: "⚫",
    speech_balloon: "💬", thought_balloon: "💭", email: "📧", envelope: "✉️", inbox_tray: "📥", outbox_tray: "📤",
    package: "📦", coffee: "☕", tea: "🍵", beer: "🍺", beers: "🍻", clinking_glasses: "🥂", pizza: "🍕", cake: "🍰",
    birthday: "🎂", cookie: "🍪", popcorn: "🍿", sunny: "☀️", rainbow: "🌈", cloud: "☁️", snowflake: "❄️", umbrella: "☔",
    earth_americas: "🌎", musical_note: "🎵", notes: "🎶", camera: "📷", computer: "💻", keyboard: "⌨️", iphone: "📱",
    moneybag: "💰", dollar: "💵", money_with_wings: "💸", shield: "🛡️", crown: "👑", gem: "💎", rose: "🌹", seedling: "🌱",
    herb: "🌿", four_leaf_clover: "🍀", cactus: "🌵", turtle: "🐢", snail: "🐌", sloth: "🦥", ok: "🆗", new: "🆕", cool: "🆒",
    sos: "🆘", up: "🆙", soon: "🔜", top: "🔝", heavy_dollar_sign: "💲", hammer_and_wrench: "🛠️", date: "📅", memo: "📝",
  }),
]);

/** Slack's reaction name for an emoji (its first name in the table, without the skin tone), when there's one. */
const REACTION_NAMES = new Map<string, string>();
for (const [name, emoji] of REACTION_EMOJI) if (!REACTION_NAMES.has(bare(emoji))) REACTION_NAMES.set(bare(emoji), name);
export const reactionName = (emoji: string) => REACTION_NAMES.get(bare(emoji.trim()));

/** A reaction's name without its skin tone ("+1::skin-tone-3" → "+1"). */
export const bareName = (name: string) => name.replace(/::skin-tone-\d$/, "");

/** The emoji for a Slack reaction name (with its skin tone, for a one-character emoji), or :name: for one it doesn't know (a custom emoji). */
export function emojiOf(name: string): string {
  const base = REACTION_EMOJI.get(bareName(name));
  if (!base) return `:${bareName(name)}:`;
  const tone = name.match(/::skin-tone-([2-6])$/);
  const single = base.replace(/\uFE0F/g, "");
  return tone && [...single].length === 1 ? single + String.fromCodePoint(0x1f3fb + Number(tone[1]) - 2) : base;
}

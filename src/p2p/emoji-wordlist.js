/**
 * emoji-wordlist.js
 * 128 emoji from OpenMoji used as the "visual seed" for Option B authentication.
 *
 * Structure: 8 categories, indices 0–127.
 * Each entry: { hex, name, category }
 *   - hex:      Unicode codepoint (used to build the OpenMoji SVG URL)
 *   - name:     Unicode annotation (used as a label and to derive the seed)
 *   - category: UI group
 *
 * OpenMoji SVG URL:
 *   https://cdn.jsdelivr.net/npm/openmoji@16.0.0/color/svg/${hex.toUpperCase()}.svg
 *
 * To swap an emoji: remove the entry and replace it at the same index position.
 * NEVER reorder already-published entries — it would change the index→emoji mapping
 * and invalidate all existing seeds.
 */

export const EMOJI_WORDLIST = [
  // ── 0–15  Mammals (16) ───────────────────────────────────────────────────────
  { hex: '1F436', name: 'dog face', category: 'mammals' },
  { hex: '1F431', name: 'cat face', category: 'mammals' },
  { hex: '1F42A', name: 'camel', category: 'mammals' },
  { hex: '1F405', name: 'tiger', category: 'mammals' },
  { hex: '1F418', name: 'elephant', category: 'mammals' },
  { hex: '1F992', name: 'giraffe', category: 'mammals' },
  { hex: '1F98F', name: 'rhinoceros', category: 'mammals' },
  { hex: '1F43C', name: 'panda', category: 'mammals' },
  { hex: '1F401', name: 'mouse', category: 'mammals' },
  { hex: '1F993', name: 'zebra', category: 'mammals' },
  { hex: '1F998', name: 'kangaroo', category: 'mammals' },
  { hex: '1F987', name: 'bat', category: 'mammals' },
  { hex: '1F437', name: 'pig face', category: 'mammals' },
  { hex: '1F40E', name: 'horse', category: 'mammals' },
  { hex: '1F43B', name: 'bear', category: 'mammals' },
  { hex: '1F9A3', name: 'mammoth', category: 'mammals' },

  // ── 16–31  Other Animals (16) ────────────────────────────────────────────────
  { hex: '1F427', name: 'penguin', category: 'creatures' },
  { hex: '1F989', name: 'owl', category: 'creatures' },
  { hex: '1F985', name: 'eagle', category: 'creatures' },
  { hex: '1F9A9', name: 'flamingo', category: 'creatures' },
  { hex: '1F99A', name: 'peacock', category: 'creatures' },
  { hex: '1F99C', name: 'parrot', category: 'creatures' },
  { hex: '1F988', name: 'shark', category: 'creatures' },
  { hex: '1F419', name: 'octopus', category: 'creatures' },
  { hex: '1F980', name: 'crab', category: 'creatures' },
  { hex: '1F42C', name: 'dolphin', category: 'creatures' },
  { hex: '1F98B', name: 'butterfly', category: 'creatures' },
  { hex: '1F41D', name: 'honeybee', category: 'creatures' },
  { hex: '1F577', name: 'spider', category: 'creatures' },
  { hex: '1F40D', name: 'snake', category: 'creatures' },
  { hex: '1F422', name: 'turtle', category: 'creatures' },
  { hex: '1F407', name: 'rabbit', category: 'creatures' },

  // ── 32–47  Fruits (16) ───────────────────────────────────────────────────────
  { hex: '1F34E', name: 'red apple', category: 'fruits' },
  { hex: '1F34B', name: 'lemon', category: 'fruits' },
  { hex: '1F347', name: 'grapes', category: 'fruits' },
  { hex: '1F353', name: 'strawberry', category: 'fruits' },
  { hex: '1F349', name: 'watermelon', category: 'fruits' },
  { hex: '1F34D', name: 'pineapple', category: 'fruits' },
  { hex: '1F34C', name: 'banana', category: 'fruits' },
  { hex: '1F351', name: 'peach', category: 'fruits' },
  { hex: '1F352', name: 'cherries', category: 'fruits' },
  { hex: '1F96D', name: 'mango', category: 'fruits' },
  { hex: '1F965', name: 'coconut', category: 'fruits' },
  { hex: '1F95D', name: 'kiwi fruit', category: 'fruits' },
  { hex: '1FAD0', name: 'blueberries', category: 'fruits' },
  { hex: '1F34A', name: 'tangerine', category: 'fruits' },
  { hex: '1F350', name: 'pear', category: 'fruits' },
  { hex: '1F348', name: 'melon', category: 'fruits' },

  // ── 48–63  Vegetables & Fungi (16) ───────────────────────────────────────────
  { hex: '1F951', name: 'avocado', category: 'vegetables' },
  { hex: '1F346', name: 'eggplant', category: 'vegetables' },
  { hex: '1F954', name: 'potato', category: 'vegetables' },
  { hex: '1F955', name: 'carrot', category: 'vegetables' },
  { hex: '1F33D', name: 'ear of corn', category: 'vegetables' },
  { hex: '1F336', name: 'hot pepper', category: 'vegetables' },
  { hex: '1FAD1', name: 'bell pepper', category: 'vegetables' },
  { hex: '1F952', name: 'cucumber', category: 'vegetables' },
  { hex: '1F966', name: 'broccoli', category: 'vegetables' },
  { hex: '1F9C4', name: 'garlic', category: 'vegetables' },
  { hex: '1F9C5', name: 'onion', category: 'vegetables' },
  { hex: '1F345', name: 'tomato', category: 'vegetables' },
  { hex: '1F330', name: 'chestnut', category: 'vegetables' },
  { hex: '1FAD8', name: 'beans', category: 'vegetables' },
  { hex: '1FAD2', name: 'olive', category: 'vegetables' },
  { hex: '1F344', name: 'mushroom', category: 'vegetables' },

  // ── 64–78  Plants & Nature (15) ──────────────────────────────────────────────
  { hex: '1F339', name: 'rose', category: 'nature' },
  { hex: '1F33B', name: 'sunflower', category: 'nature' },
  { hex: '1FAB7', name: 'lotus', category: 'nature' },
  { hex: '1F337', name: 'tulip', category: 'nature' },
  { hex: '1F335', name: 'cactus', category: 'nature' },
  { hex: '1F341', name: 'maple leaf', category: 'nature' },
  { hex: '1F332', name: 'evergreen tree', category: 'nature' },
  { hex: '2600', name: 'sun', category: 'nature' },
  { hex: '1F319', name: 'crescent moon', category: 'nature' },
  { hex: '1F315', name: 'full moon', category: 'nature' },
  { hex: '2B50', name: 'star', category: 'nature' },
  { hex: '1F320', name: 'shooting star', category: 'nature' },
  { hex: '2601', name: 'cloud', category: 'nature' },
  { hex: '1F308', name: 'rainbow', category: 'nature' },
  { hex: '2744', name: 'snowflake', category: 'nature' },

  // ── 79–94  Sports & Games (16) ───────────────────────────────────────────────
  { hex: '26BD', name: 'soccer ball', category: 'sports' },
  { hex: '1F3C0', name: 'basketball', category: 'sports' },
  { hex: '1F3BE', name: 'tennis', category: 'sports' },
  { hex: '1F3B3', name: 'bowling', category: 'sports' },
  { hex: '1F3AF', name: 'bullseye', category: 'sports' },
  { hex: '1F3B2', name: 'game die', category: 'sports' },
  { hex: '265F', name: 'chess pawn', category: 'sports' },
  { hex: '1F9E9', name: 'puzzle piece', category: 'sports' },
  { hex: '1F3AE', name: 'video game', category: 'sports' },
  { hex: '26BE', name: 'baseball', category: 'sports' },
  { hex: '1F93F', name: 'diving mask', category: 'sports' },
  { hex: '1F3F9', name: 'bow and arrow', category: 'sports' },
  { hex: '2603', name: 'snowman', category: 'sports' },
  { hex: '1F384', name: 'christmas tree', category: 'sports' },
  { hex: '1F525', name: 'fire', category: 'sports' },
  { hex: '1F30A', name: 'water wave', category: 'sports' },

  // ── 95–110  Music & Misc (16) ────────────────────────────────────────────────
  { hex: '1F3B7', name: 'saxophone', category: 'music' },
  { hex: '1F3B8', name: 'guitar', category: 'music' },
  { hex: '1F3BB', name: 'violin', category: 'music' },
  { hex: '1F941', name: 'drum', category: 'music' },
  { hex: '1F3BA', name: 'trumpet', category: 'music' },
  { hex: '1F3B9', name: 'musical keyboard', category: 'music' },
  { hex: '1F9B7', name: 'tooth', category: 'music' },
  { hex: '1F444', name: 'mouth', category: 'music' },
  { hex: '1F442', name: 'ear', category: 'music' },
  { hex: '1FAC6', name: 'fingerprint', category: 'music' },
  { hex: '1F9EF', name: 'fire extinguisher', category: 'music' },
  { hex: '26A1', name: 'lightning', category: 'music' },
  { hex: '1F4A7', name: 'droplet', category: 'music' },
  { hex: '1F9F2', name: 'magnet', category: 'music' },
  { hex: '1F4A3', name: 'bomb', category: 'music' },
  { hex: '1F9F0', name: 'toolbox', category: 'music' },

  // ── 111–127  Objects & Tech (17) ─────────────────────────────────────────────
  { hex: '1F451', name: 'crown', category: 'objects' },
  { hex: '1F48E', name: 'gem stone', category: 'objects' },
  { hex: '1F48D', name: 'ring', category: 'objects' },
  { hex: '1F52E', name: 'crystal ball', category: 'objects' },
  { hex: '1F528', name: 'hammer', category: 'objects' },
  { hex: '1F527', name: 'wrench', category: 'objects' },
  { hex: '2699', name: 'gear', category: 'objects' },
  { hex: '1FA93', name: 'axe', category: 'objects' },
  { hex: '1F6E1', name: 'shield', category: 'objects' },
  { hex: '1F52D', name: 'telescope', category: 'objects' },
  { hex: '1F52C', name: 'microscope', category: 'objects' },
  { hex: '1F9EC', name: 'dna', category: 'objects' },
  { hex: '1F511', name: 'key', category: 'objects' },
  { hex: '1F4F1', name: 'mobile phone', category: 'objects' },
  { hex: '1F4E3', name: 'megaphone', category: 'objects' },
  { hex: '1F4DD', name: 'pencil', category: 'objects' },
  { hex: '1F6BE', name: 'water closet', category: 'objects' },
]

/** Returns the OpenMoji SVG URL for an emoji given its hex codepoint. */
export function emojiSvgUrl(hex) {
  return `https://cdn.jsdelivr.net/npm/openmoji@16.0.0/color/svg/${hex.toUpperCase()}.svg`
}

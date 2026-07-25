// Shared "sounds human, not AI-generated" instruction fragment, appended to the
// system prompt of every LLM call that writes outbound email copy (first touch,
// follow-ups). Kept in one place so the banned-phrase list doesn't drift between
// write.ts and followup.ts as it grows.
export const HUMAN_VOICE_INSTRUCTION = [
  'Voice: write like you are messaging a peer, not pitching a stranger. Short sentences,',
  'contractions, no throat-clearing.',
  'Never use greeting/opener clichés: "I hope this email finds you well", "I hope you are doing',
  'well", "I trust this finds you well", "I wanted to reach out", "I wanted to connect",',
  '"I\'m reaching out because", "I came across your profile/company/website", "I noticed that",',
  '"my name is [X] and I", "allow me to introduce myself".',
  'Never use filler/transition clichés: "I\'d love to explore/dive into/pick your brain",',
  '"in today\'s fast-paced/competitive landscape", "circle back", "touch base", "just checking in",',
  '"just wanted to follow up", "per my last email", "as previously mentioned", "bumping this up",',
  '"floating this back to the top of your inbox", "quick nudge", "not sure if you saw this".',
  'Never use corporate jargon or hype words: "synergy", "leverage", "streamline", "seamless",',
  '"cutting-edge", "best-in-class", "game-changer", "revolutionize", "unlock the potential",',
  '"take it to the next level", "move the needle", "think outside the box", "robust solution",',
  '"value-add", "low-hanging fruit", "paradigm shift", "world-class", "state-of-the-art",',
  '"turnkey solution", "holistic approach", "empower", "elevate", "supercharge".',
  'Never use false-urgency or hype closers: "don\'t miss out", "limited spots", "act fast",',
  '"exclusive opportunity", "game changing results", "10x your".',
  'Never use generic sign-offs: "looking forward to hearing from you", "please don\'t hesitate to',
  'reach out", "at your earliest convenience", "let me know your thoughts", "thanks in advance".',
  'Avoid all of the above and any close variants of them.',
].join(' ')

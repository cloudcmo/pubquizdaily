// netlify/lib/friday-copy.js
// Hand-written rotating copy for the Friday Best-of (23 Oct 2026). Since then
// the email makes NO AI calls: freshness comes from rotating these lines, the
// week's real questions, and real examples from each game's past puzzles
// (netlify/lib/email-banks/*.json). House rules: no em dashes anywhere, UK
// spelling, and never name the older board games Words and Guff might be
// compared with.
//
// Add lines freely: rotation adapts to however many there are.

// The quiz card when Pub Quiz Daily is the lead block. {n} = number of
// questions. The taster (one of this week's real questions, never the one in
// the subject line) is shown under the intro with tasterLabel above it.
const QUIZ_INTROS = [
  { kicker: 'The Friday Best-of 🍺', headline: "This week's finest", intro: "{n} of the week's best questions, about ninety seconds of fun. See how many you'd have got.", tasterLabel: 'One to warm up with' },
  { kicker: 'Seven days, one round', headline: 'The best of the week, in one go', intro: "We've picked the {n} questions that split the room this week. No buzzers, no pressure, just you and your general knowledge.", tasterLabel: 'Here is one of them' },
  { kicker: 'Last orders 🍻', headline: 'Missed a day? Catch up here', intro: "Every question worth asking this week, all in one round. {n} questions, done before the kettle boils.", tasterLabel: 'For starters' },
  { kicker: 'Friday quiz time', headline: 'How sharp were you this week?', intro: "The week's quiz, boiled down to its {n} best questions. Some easy, some fiendish, all answered by real players before you.", tasterLabel: 'A taste of this week' },
  { kicker: 'Round of the week', headline: 'Pens down, here comes Friday', intro: "{n} questions from the past seven days. You might know more than you think, or less than you hope.", tasterLabel: 'Could you get this one?' },
  { kicker: 'Quiz night, any time', headline: 'The pub quiz that fits a coffee break', intro: "{n} questions, ninety seconds, no table to book. The week's best, chosen because they caught people out.", tasterLabel: 'This one caught a few people' },
  { kicker: 'Weekly Best-of 🍺', headline: 'Fancy a quick round?', intro: "We've gathered the week's {n} best questions into one quiz. Play it now and see how you stack up against everyone else.", tasterLabel: 'One from the round' },
  { kicker: 'Brains, warmed up', headline: 'Your Friday five minutes', intro: "Trivia, history, odd facts and the odd trick question. {n} of this week's best, waiting for you.", tasterLabel: 'Try this for size' },
  { kicker: 'Fresh from the quiz sheet', headline: 'A week of questions in one sitting', intro: "If you played every day, here's a chance to beat your score. If you didn't, here's the bit you missed. {n} questions.", tasterLabel: 'Remember this one?' },
  { kicker: 'The round that settles it', headline: 'Who knows the most? Find out', intro: "{n} questions, the same for everyone. Send it to the know-it-all in your life and compare notes.", tasterLabel: 'A starter for ten' },
  { kicker: 'Friday, at last', headline: 'Something better than the news', intro: "Start the weekend with {n} questions that are more fun than anything in your inbox. Free, quick, no login.", tasterLabel: 'Go on, have a go' },
  { kicker: 'Quiz of the week 🍺', headline: 'Pull up a stool', intro: "This week's {n} best questions are poured and waiting. No round to buy, no table to share.", tasterLabel: 'First one on the house' },
  { kicker: 'Best-of, by popular demand', headline: 'The questions people talked about', intro: "These are the {n} that got people arguing this week. Settle it for yourself.", tasterLabel: 'Here is one that started a row' },
  { kicker: 'Seven questions? More', headline: 'A proper round, nicely short', intro: "{n} questions from the week's quiz, picked for variety. A bit of everything, as a pub quiz should be.", tasterLabel: 'A little sample' },
];

// Pub Quiz Daily as one of the two smaller cards. {n} = number of questions.
// The card shows one of this week's real questions under the opener.
const PQD_CARD_OPENERS = [
  "The week's {n} best questions, in one quick round. See how many you'd have got.",
  "Missed a day of the quiz this week? Here are the {n} questions worth catching up on.",
  "{n} questions from the past seven days, about ninety seconds of fun.",
  "This week's Best-of is ready: {n} questions that caught people out.",
  "Five minutes, {n} questions, no login. The week's quiz in one go.",
  "The questions that split the room this week, gathered into one round.",
  "Fancy a quick round before the weekend? {n} questions, all from this week.",
  "Test yourself against everyone who played this week. {n} questions, same for all.",
];

// Openers for each game's card. Each is one or two sentences that work on
// their own, followed in the email by a real example from a past puzzle.
const OPENERS = {
  whenly: [
    'Have you tried Whenly, the daily guess-the-year game? A handful of moments from history, and all you have to do is say when.',
    'Whenly asks one simple thing: when did it happen? Close counts, spot on counts more.',
    'Good with dates? Whenly gives you a few moments from history each day. Pick the year and see how close you get.',
    'A few moments from history, a guess at the year for each. Whenly takes a minute and teaches you something every time.',
    'Whenly is the daily game for anyone who has ever said "that was ages ago". How long ago, exactly?',
    'History, one year at a time. Whenly scores you on how close you get, so a near miss still counts.',
    'Ever argued about whether something was the seventies or the eighties? Whenly settles it daily.',
  ],
  whatword: [
    'Have you tried What Word? Three unusual words a day. Can you tell what they mean?',
    'What Word gives you three words you have probably never used, and four options to choose from.',
    'One easy, one medium, one hard. What Word is three minutes with the odder corners of the language.',
    'Know your laconic from your lachrymose? What Word tests you with three words a day.',
    'Three words, four options each, and a little story behind every answer. That is What Word.',
    'For people who like words more than is strictly necessary: What Word, three a day.',
  ],
  groupie: [
    'Have you tried Groupie? Sixteen words, four hidden groups of four, and some of them are there to trip you up.',
    'Groupie is your daily four play. Sort sixteen words into four groups before your slips run out.',
    'Sixteen words on a grid, all of them suspicious. Groupie is the daily puzzle with a very British sense of humour.',
    'Find the four that go together, then do it three more times. Groupie, every day.',
    'Groupie loves a red herring. Every grid has a few words that look like they belong somewhere else.',
    'A grid of sixteen, four groups, one trick or two. Groupie takes five minutes and a bit of lateral thinking.',
  ],
  hexadec: [
    'Have you tried Hexadec? Sixteen tiles hide four four-letter words that use every tile exactly.',
    'Hexadec looks easy until you find three good words and are left holding nonsense.',
    'Four the win: Hexadec hides four words in sixteen tiles, and every tile has to be used.',
    'Sixteen letters, four words, no leftovers. Hexadec is a tidy little brain-teaser for the morning.',
    'There are far more words in a Hexadec grid than you can use. The trick is finding the four that fit together.',
    'Hexadec is a puzzle for people who like everything to come out even.',
  ],
  wagdaily: [
    'Have you tried Words and Guff Daily? A game already under way, a rack of eight tiles, and one play to find the best word.',
    'Words and Guff Daily asks one question: what is the best play on the board? Everyone gets the same rack.',
    'Eight tiles, one board, one shot. Can you find the play that scores the most?',
    'Words and Guff Daily: a single move, the same for everyone. Did you find the best word, or just a good one?',
    'Find the best word, not just a good one. Words and Guff Daily is one move a day, and it is harder than it looks.',
    'One rack, one board, one move. Words and Guff Daily is the shortest proper word game you will play all day.',
  ],
  spellbound: [
    'Have you tried Spellbound? Letters fall, and a dozen words are hiding in the drop. Spell ten before the pile buries you.',
    'Spellbound is word Tetris, daily: letters tumble in, and you clear them by spelling words.',
    'A dozen words hide in each day\'s falling letters. Spellbound asks you to find ten before it is too late.',
    'Falling letters, hidden words, and a pile that keeps on growing. That is Spellbound.',
    'Spellbound rewards quick eyes: the words are all there, if you can see them in time.',
    'If you like a bit of pressure with your word games, Spellbound is the one.',
  ],
  wordminer: [
    'Have you tried Wordminer? Minesweeper, but the squares hide words as well as mines.',
    'Wordminer: every board has a theme, and a word square never holds a mine. Guess the word and the rest of it is safe.',
    'Numbers count the mines, letters belong to words. Wordminer is minesweeping for people who like words.',
    'Fewer taps and a quicker finish score more. Wordminer is a daily board with a theme to crack.',
    'Spot the theme, guess the words, and the mines give themselves away. That is Wordminer.',
    'Wordminer turns a classic into a word game. Careful where you tap.',
  ],
  guffitaire: [
    'Have you tried Guffitaire? Solitaire, but the cards are letters.',
    'Guffitaire: turn the pile, build six words in the columns, then bank your score or push your luck.',
    'Five lives, a par to beat, and one deal a day, the same for everyone. Guffitaire is patience with a twist.',
    'Guffitaire is solitaire for word lovers. Bank early and play safe, or keep going for a bigger score.',
    'One deal a day, six columns, a pile of letters. How far will you push your luck?',
    'If you grew up playing patience, Guffitaire will feel familiar. Until the cards start spelling things.',
  ],
  helmet: [
    'Have you tried Helmet? Spell words through touching tiles, even round corners, and everything above comes crashing down.',
    'Helmet is one of the newest Guff games: clear the building site one word at a time, and mind the dynamite.',
    'Words can bend round corners in Helmet. Clear a word and the tiles above tumble down into new places.',
    'Hard hat on. Helmet gives you a building site of letters to clear, and every site can be cleared.',
    'Helmet rewards thinking two moves ahead: what falls when this word goes?',
    'Girders, dynamite and a site that can always be cleared. Helmet, a word game with a bit of demolition.',
  ],
};

module.exports = { QUIZ_INTROS, PQD_CARD_OPENERS, OPENERS };

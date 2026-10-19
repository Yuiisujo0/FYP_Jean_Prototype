/**
 * jwork builds workflows from a task; it is not a chat. A greeting, thanks or "what can you do" should still get a
 * friendly answer instead of an error or a made-up workflow, and it must not cost an AI call. Matching is deliberately
 * narrow: anything that mentions data work goes to the AI as usual.
 */

export interface SmallTalk {
  /** What jwork says back. */
  reply: string;
  /** Requests worth offering next to the reply. */
  suggestions: string[];
}

const SUGGESTIONS = [
  'Read a CSV of student marks and flag everyone below 50, then save them to the database',
  'Read employees, keep those in Sales earning over 6000, and sort them by salary',
  'Read sales orders and total the amount for each customer',
];

const TASK_WORDS = /\b(read|filter|keep|flag|sort|group|total|sum|count|average|join|merge|export|save|csv|excel|xlsx|dataset|rows?|columns?|where|below|above|over|under|highest|lowest|top)\b/i;

const GREETING = /^(hi+|hey+|hello+|hiya|yo|howdy|good (morning|afternoon|evening)|selamat (pagi|petang|malam)|salam|sup|greetings)\b[\s!.,?]*$/i;
const HOW_ARE_YOU = /^(hi+|hey+|hello+)?[\s,!.]*(how are you|how('| i)?s it going|what'?s up|how do you do)( today)?[\s!.?]*$/i;
const THANKS = /^(thanks?|thank you|thx|ty|cheers|terima kasih)( (a lot|so much|very much))?[\s!.]*$/i;
const BYE = /^(bye|goodbye|see you|cya|good night)[\s!.]*$/i;
const WHO = /^(who are you|what are you|what is jwork|what'?s jwork)[\s?!.]*$/i;
const HELP = /^(help|what can you do|what do you do|how does (this|it) work|how do i (use|start)( this| it)?|\?)[\s?!.]*$/i;

export function smallTalk(text: string): SmallTalk | null {
  const t = text.trim();
  if (!t || t.length > 60 || TASK_WORDS.test(t)) return null;
  if (GREETING.test(t)) {
    return { reply: 'Hi! Tell me what you want done with your data and I will build the steps, test them on your data and show you what happened to every row. For example:', suggestions: SUGGESTIONS };
  }
  if (HOW_ARE_YOU.test(t)) {
    return { reply: 'Doing well, thanks. I am an assistant for data workflows rather than a general chat, so the most useful thing you can tell me is a task. For example:', suggestions: SUGGESTIONS };
  }
  if (THANKS.test(t)) return { reply: 'You are welcome. Describe another task whenever you are ready.', suggestions: [] };
  if (BYE.test(t)) return { reply: 'Goodbye. Your workflows and requests are kept in this browser.', suggestions: [] };
  if (WHO.test(t) || HELP.test(t)) {
    return {
      reply: 'jwork turns a plain-language request into a short workflow (read a file, filter, sort, group, join, save), runs it on your data in the browser, and shows a review of every row before you approve the result. Your row values never leave your browser. Try one of these:',
      suggestions: SUGGESTIONS,
    };
  }
  return null;
}

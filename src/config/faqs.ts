/**
 * FAQ content.
 *
 * Every answer must be factually true today. Policy numbers come from
 * BOOKING_POLICY, never typed into an answer - see the cancellation entry.
 */
import { BOOKING_POLICY } from "./site";

const { moveNoticeHours, moveWindowDays } = BOOKING_POLICY;

export interface Faq {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
}

export const FAQS: readonly Faq[] = [
  {
    id: "technical-experience",
    question: "Do I need technical experience?",
    answer:
      "Not for Sessions 1 to 3. They are built for people who use AI day to day and want dependable results, and they assume no coding background. Sessions 5 and 6 are more technical: Session 5 covers how modern AI applications are assembled, and Session 6 works on a real project you already have.",
  },
  {
    id: "which-session",
    question: "Which session should I start with?",
    answer:
      "Most people start at Session 1, because the method it teaches makes every later session more useful. If you already prompt confidently and want to build, start at Session 2 or 3. If you are already building and want agents, start at Session 4.",
  },
  {
    id: "online",
    question: "Are sessions online?",
    answer:
      "Yes. Every session is delivered privately over Microsoft Teams, one to one. You receive the joining details once your booking is confirmed.",
  },
  {
    id: "evenings",
    question: "Are evening appointments available?",
    answer:
      "Yes, and they are the default. Sessions run in the evening Monday to Thursday plus selected weekend slots, because most people booking these work or study during the day. Times are shown in your own timezone alongside Gulf Standard Time.",
  },
  {
    id: "single-session",
    question: "Can I book just one session?",
    answer:
      "Yes. Every session is sold individually and stands on its own. There is no package you have to commit to and no minimum number of sessions.",
  },
  {
    id: "combine-sessions",
    question: "Can I combine two sessions?",
    answer:
      "Not at the moment. Sessions are currently sold one at a time. Combined two-session pathways are planned, but they are not available yet and are not listed on this page.",
  },
  {
    id: "session-six",
    question: "What is required for Session 6?",
    answer:
      "Session 6 is an advanced implementation session rather than an introductory one. It assumes Session 5 or equivalent experience, and depending on your project, Sessions 3 or 4 may also be relevant. You need a real project to work on. If the fit is not right, a more suitable session will be recommended before you book.",
  },
  {
    id: "build-for-me",
    question: "Do you build the application for me?",
    answer:
      "No. These are guidance and implementation-support sessions, not outsourced development. In Session 6 we work through your real project together and you will make substantial progress, but the session price covers the defined live session and not unlimited engineering work. Anything beyond that scope is quoted separately.",
  },
  {
    id: "prepare",
    question: "What should I prepare?",
    answer:
      "After booking you will receive a short preparation checklist and an intake form. Bring a real task or project rather than a hypothetical one - the sessions are far more valuable when applied to work you actually need to do.",
  },
  {
    id: "cancellation",
    question: "What is the cancellation and rescheduling policy?",
    answer: `To move your session, email us at least ${moveNoticeHours} hours before it starts and we move it free to another open time within ${moveWindowDays} days. There is no refund if you change your mind, cannot attend or miss your session; less than ${moveNoticeHours} hours before, a session cannot be moved. If we cancel, you choose a full refund or a new time. The Booking and Refund Policy has the full details, including your legal rights.`,
  },
];

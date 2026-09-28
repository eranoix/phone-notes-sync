const svgMap = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160">
  <rect width="320" height="160" fill="#f6f3ec"/>
  <path d="M20 130 C 90 20, 170 150, 300 30" stroke="#d99a1c" stroke-width="6" fill="none"/>
  <circle cx="20" cy="130" r="8" fill="#2f8f5b"/><circle cx="300" cy="30" r="8" fill="#c2413b"/>
</svg>`,
  'utf-8',
);

export interface DemoNote {
  id: string;
  title: string;
  html: string;
  daysAgo: number;
  attachments?: Array<{ filename: string; contentType: string; content: Buffer; contentId: string }>;
}

export const DEMO_NOTES: DemoNote[] = [
  {
    id: '6F1C2A3B-0D4E-4F51-9A62-7B8C9D0E1F21',
    title: 'Groceries',
    daysAgo: 2,
    html: `<div><h1>Groceries</h1></div><ul><li>Oat milk</li><li>Sourdough</li><li>Lemons (4)</li><li>Coffee beans, medium roast</li></ul>`,
  },
  {
    id: '2B7D9E10-4C3A-4B8F-8E21-5A6B7C8D9E02',
    title: 'Standup notes, Tuesday',
    daysAgo: 1,
    html: `<div><h1>Standup notes, Tuesday</h1></div><div><b>Yesterday:</b> finished the retry policy for the export job.</div><div><b>Today:</b> pair on the search ranking, review two pull requests.</div><div><b>Blockers:</b> none</div>`,
  },
  {
    id: '9A0B1C2D-3E4F-4A5B-9C6D-7E8F9A0B1C23',
    title: 'Road trip, coast route',
    daysAgo: 6,
    html: `<div><h1>Road trip, coast route</h1></div><div>Day 1: Harbor Town to Pine Cove, 210 km.</div><div>Day 2: Pine Cove to Saltmarsh, stop at the lighthouse.</div><div><object type="application/x-apple-msg-attachment" data="cid:route-map@example.com"></object></div>`,
    attachments: [
      { filename: 'route-map.svg', contentType: 'image/svg+xml', content: svgMap, contentId: 'route-map@example.com' },
    ],
  },
  {
    id: '4D5E6F70-8192-4A3B-8C4D-5E6F7A8B9C04',
    title: 'Book quotes',
    daysAgo: 12,
    html: `<div><h1>Book quotes</h1></div><blockquote>"The map is not the territory, but it is a start."</blockquote><div>From a made-up novel I keep meaning to write.</div>`,
  },
  {
    id: '7E8F9A0B-1C2D-4E3F-9A4B-5C6D7E8F9A05',
    title: 'Parking spot',
    daysAgo: 3,
    html: `<div><h1>Parking spot</h1></div><div>Level 3, row F, near the blue elevator.</div>`,
  },
  {
    id: '1A2B3C4D-5E6F-4A7B-8C9D-0E1F2A3B4C06',
    title: 'Sourdough starter',
    daysAgo: 20,
    html: `<div><h1>Sourdough starter</h1></div><ol><li>50 g flour + 50 g water, every 12 h</li><li>Ready when it doubles in 4 to 6 h</li><li>Keep it in the fridge between bakes</li></ol>`,
  },
];

export const EDITS: Array<{ id: string; title: string; html: string }> = [
  {
    id: '6F1C2A3B-0D4E-4F51-9A62-7B8C9D0E1F21',
    title: 'Groceries',
    html: `<div><h1>Groceries</h1></div><ul><li><s>Oat milk</s></li><li><s>Sourdough</s></li><li>Lemons (4)</li><li>Coffee beans, medium roast</li><li>Basil for the pasta</li></ul>`,
  },
  {
    id: '2B7D9E10-4C3A-4B8F-8E21-5A6B7C8D9E02',
    title: 'Standup notes, Tuesday',
    html: `<div><h1>Standup notes, Tuesday</h1></div><div><b>Yesterday:</b> finished the retry policy for the export job.</div><div><b>Today:</b> pair on the search ranking, review two pull requests.</div><div><b>Blockers:</b> waiting on a staging database snapshot.</div><div><i>Follow up after lunch.</i></div>`,
  },
];

export const DELETES = ['7E8F9A0B-1C2D-4E3F-9A4B-5C6D7E8F9A05'];

export const LATE_ARRIVAL: DemoNote = {
  id: '3C4D5E6F-7A8B-4C9D-8E0F-1A2B3C4D5E07',
  title: 'Weekend ideas',
  daysAgo: 0,
  html: `<div><h1>Weekend ideas</h1></div><ul><li>Farmers market on Saturday morning</li><li>Try the new ramen place on Elm Street</li><li>Finish the bookshelf</li></ul>`,
};

// Vocabulary for the dev seed. Every company, person, and domain here is
// invented — nothing maps to a real organisation or individual. The `.test`
// TLD on operator mailboxes is reserved by RFC 2606 and can never resolve.

export interface SeedClientFixture {
  readonly name: string
  readonly status: 'active' | 'paused' | 'archived'
  readonly valueProp: string
  readonly bookingLink: string
}

export const CLIENT_FIXTURES: readonly SeedClientFixture[] = [
  {
    name: 'Northwind Analytics',
    status: 'active',
    valueProp:
      'We cut warehouse spend 40% by moving cold data off Snowflake without touching a single dashboard.',
    bookingLink: 'https://cal.example.test/northwind/intro',
  },
  {
    name: 'Kestrel Robotics',
    status: 'active',
    valueProp:
      'Autonomous pallet movers that drop into an existing racking layout — no floor rebuild, live in 6 weeks.',
    bookingLink: 'https://cal.example.test/kestrel/demo',
  },
  {
    name: 'Vantage Compliance',
    status: 'paused',
    valueProp:
      'Continuous SOC 2 and DORA evidence collection so your audit prep drops from 300 hours to 20.',
    bookingLink: 'https://cal.example.test/vantage/walkthrough',
  },
] as const

export interface SeedCampaignFixture {
  /** Index into CLIENT_FIXTURES. */
  readonly clientIndex: number
  readonly name: string
  readonly status: 'active' | 'paused' | 'archived'
  readonly replyMode: 'auto_send' | 'human_approve' | 'hybrid'
  readonly priceHandoffMode: 'book_call_and_notify' | 'notify_only' | 'configurable'
  readonly dailyTarget: number
  readonly icp: {
    readonly titles: readonly string[]
    readonly employeeRange: readonly [number, number]
    readonly industries: readonly string[]
    readonly geos: readonly string[]
  }
}

export const CAMPAIGN_FIXTURES: readonly SeedCampaignFixture[] = [
  {
    clientIndex: 0,
    name: 'Q3 Mid-Market Data Leaders',
    status: 'active',
    replyMode: 'human_approve',
    priceHandoffMode: 'book_call_and_notify',
    dailyTarget: 40,
    icp: {
      titles: ['VP Data', 'Head of Data Platform', 'Director of Analytics'],
      employeeRange: [200, 2000],
      industries: ['SaaS', 'Fintech', 'E-commerce'],
      geos: ['United States', 'Canada'],
    },
  },
  {
    clientIndex: 0,
    name: 'EU Retail Expansion',
    status: 'paused',
    replyMode: 'auto_send',
    priceHandoffMode: 'notify_only',
    dailyTarget: 25,
    icp: {
      titles: ['Head of BI', 'Data Engineering Manager'],
      employeeRange: [500, 5000],
      industries: ['Retail', 'Logistics'],
      geos: ['Germany', 'Netherlands', 'Sweden'],
    },
  },
  {
    clientIndex: 1,
    name: '3PL Warehouse Ops',
    status: 'active',
    replyMode: 'hybrid',
    priceHandoffMode: 'book_call_and_notify',
    dailyTarget: 35,
    icp: {
      titles: ['VP Operations', 'Director of Fulfilment', 'Head of Warehouse Automation'],
      employeeRange: [300, 8000],
      industries: ['Third-party Logistics', 'Distribution'],
      geos: ['United States', 'United Kingdom'],
    },
  },
  {
    clientIndex: 1,
    name: 'Cold Chain Pilot',
    status: 'active',
    replyMode: 'auto_send',
    priceHandoffMode: 'configurable',
    dailyTarget: 15,
    icp: {
      titles: ['Head of Cold Chain', 'Operations Director'],
      employeeRange: [150, 1200],
      industries: ['Food Distribution', 'Pharma Logistics'],
      geos: ['United States'],
    },
  },
  {
    clientIndex: 2,
    name: 'FinServ Compliance Heads',
    status: 'active',
    replyMode: 'human_approve',
    priceHandoffMode: 'book_call_and_notify',
    dailyTarget: 20,
    icp: {
      titles: ['Head of Compliance', 'CISO', 'Director of Risk'],
      employeeRange: [400, 6000],
      industries: ['Banking', 'Insurance', 'Payments'],
      geos: ['United Kingdom', 'Ireland', 'Singapore'],
    },
  },
] as const

export interface SeedMailboxFixture {
  readonly clientIndex: number
  readonly provider: 'gmail' | 'outlook'
  readonly emailAddress: string
  readonly displayName: string
  readonly dailyCap: number
  readonly sentToday: number
  readonly health: 'ok' | 'warning' | 'blocked'
}

// sent_today is deliberately varied: one mailbox sits at its cap (so the
// Analytics "cap used" column shows 100%), one is warning, one is blocked.
export const MAILBOX_FIXTURES: readonly SeedMailboxFixture[] = [
  {
    clientIndex: 0,
    provider: 'gmail',
    emailAddress: 'maya@northwind-analytics.test',
    displayName: 'Maya Okonkwo',
    dailyCap: 30,
    sentToday: 18,
    health: 'ok',
  },
  {
    clientIndex: 0,
    provider: 'outlook',
    emailAddress: 'daniel@northwind-analytics.test',
    displayName: 'Daniel Ferreira',
    dailyCap: 25,
    sentToday: 25,
    health: 'ok',
  },
  {
    clientIndex: 1,
    provider: 'gmail',
    emailAddress: 'priya@kestrel-robotics.test',
    displayName: 'Priya Raghunathan',
    dailyCap: 40,
    sentToday: 12,
    health: 'ok',
  },
  {
    clientIndex: 1,
    provider: 'outlook',
    emailAddress: 'tomas@kestrel-robotics.test',
    displayName: 'Tomas Lindqvist',
    dailyCap: 20,
    sentToday: 4,
    health: 'warning',
  },
  {
    clientIndex: 2,
    provider: 'gmail',
    emailAddress: 'aisha@vantage-compliance.test',
    displayName: 'Aisha Bello',
    dailyCap: 20,
    sentToday: 0,
    health: 'blocked',
  },
  // Every client needs at least one healthy mailbox, otherwise its campaigns
  // have no send pool and would produce `contacted` cases with no emails.
  {
    clientIndex: 2,
    provider: 'outlook',
    emailAddress: 'ruth@vantage-compliance.test',
    displayName: 'Ruth Adeyemi',
    dailyCap: 15,
    sentToday: 7,
    health: 'ok',
  },
] as const

export interface SeedCompanyFixture {
  readonly name: string
  readonly domain: string
  readonly industry: string
  readonly employees: number
  readonly city: string
}

// 84 invented target companies — more than the case count so the generator can
// draw distinct companies per campaign without ever colliding on company_key.
export const COMPANY_FIXTURES: readonly SeedCompanyFixture[] = [
  { name: 'Brightloom Retail', domain: 'brightloom.test', industry: 'Retail', employees: 1400, city: 'Chicago' },
  { name: 'Kestrel Freight', domain: 'kestrelfreight.test', industry: 'Logistics', employees: 820, city: 'Memphis' },
  { name: 'Halcyon Payments', domain: 'halcyonpay.test', industry: 'Payments', employees: 2100, city: 'Austin' },
  { name: 'Marlowe Health', domain: 'marlowehealth.test', industry: 'Healthcare', employees: 3400, city: 'Boston' },
  { name: 'Tidewater Logistics', domain: 'tidewaterlog.test', industry: 'Logistics', employees: 640, city: 'Norfolk' },
  { name: 'Ironvale Manufacturing', domain: 'ironvale.test', industry: 'Manufacturing', employees: 2900, city: 'Pittsburgh' },
  { name: 'Solstice Grocers', domain: 'solsticegrocers.test', industry: 'Food Distribution', employees: 1750, city: 'Denver' },
  { name: 'Pinnacle Underwriting', domain: 'pinnacleuw.test', industry: 'Insurance', employees: 980, city: 'Hartford' },
  { name: 'Verity Bank Group', domain: 'veritybank.test', industry: 'Banking', employees: 5200, city: 'London' },
  { name: 'Northbeam Commerce', domain: 'northbeam-commerce.test', industry: 'E-commerce', employees: 430, city: 'Seattle' },
  { name: 'Cedarpoint Foods', domain: 'cedarpointfoods.test', industry: 'Food Distribution', employees: 1150, city: 'Columbus' },
  { name: 'Quillon Software', domain: 'quillon.test', industry: 'SaaS', employees: 310, city: 'Toronto' },
  { name: 'Arclight Media', domain: 'arclightmedia.test', industry: 'Media', employees: 560, city: 'Los Angeles' },
  { name: 'Fenwick Pharma', domain: 'fenwickpharma.test', industry: 'Pharma Logistics', employees: 2400, city: 'Basel' },
  { name: 'Redstone Distribution', domain: 'redstonedist.test', industry: 'Distribution', employees: 1900, city: 'Dallas' },
  { name: 'Lumen Fulfilment', domain: 'lumenfulfil.test', industry: 'Third-party Logistics', employees: 720, city: 'Reno' },
  { name: 'Ashcroft Insurance', domain: 'ashcroftins.test', industry: 'Insurance', employees: 1600, city: 'Dublin' },
  { name: 'Wexler Capital', domain: 'wexlercapital.test', industry: 'Banking', employees: 890, city: 'Singapore' },
  { name: 'Orchard Lane Retail', domain: 'orchardlane.test', industry: 'Retail', employees: 2600, city: 'Manchester' },
  { name: 'Sable Robotics', domain: 'sablerobotics.test', industry: 'Manufacturing', employees: 380, city: 'Detroit' },
  { name: 'Vireo Analytics', domain: 'vireoanalytics.test', industry: 'SaaS', employees: 240, city: 'Amsterdam' },
  { name: 'Harborview Shipping', domain: 'harborviewship.test', industry: 'Logistics', employees: 3100, city: 'Rotterdam' },
  { name: 'Elmwood Grocery Co', domain: 'elmwoodgrocery.test', industry: 'Food Distribution', employees: 940, city: 'Portland' },
  { name: 'Trellis Fintech', domain: 'trellisfintech.test', industry: 'Fintech', employees: 470, city: 'New York' },
  { name: 'Bracken Industrial', domain: 'brackenind.test', industry: 'Manufacturing', employees: 4100, city: 'Birmingham' },
  { name: 'Caldera Energy Services', domain: 'calderaenergy.test', industry: 'Energy', employees: 1300, city: 'Houston' },
  { name: 'Meridian Freightways', domain: 'meridianfreight.test', industry: 'Third-party Logistics', employees: 2200, city: 'Kansas City' },
  { name: 'Ashgrove Commerce', domain: 'ashgrovecommerce.test', industry: 'E-commerce', employees: 590, city: 'Copenhagen' },
  { name: 'Thornbury Foods', domain: 'thornburyfoods.test', industry: 'Food Distribution', employees: 680, city: 'Bristol' },
  { name: 'Glenmoor Assurance', domain: 'glenmoor.test', industry: 'Insurance', employees: 2050, city: 'Edinburgh' },
  { name: 'Pallas Commerce', domain: 'pallascommerce.test', industry: 'E-commerce', employees: 510, city: 'Berlin' },
  { name: 'Ridgeway Storage', domain: 'ridgewaystorage.test', industry: 'Distribution', employees: 760, city: 'Phoenix' },
  { name: 'Aldergate Trust', domain: 'aldergatetrust.test', industry: 'Banking', employees: 3800, city: 'London' },
  { name: 'Silverbirch Retail', domain: 'silverbirch.test', industry: 'Retail', employees: 1250, city: 'Stockholm' },
  { name: 'Cobalt Freight Systems', domain: 'cobaltfreight.test', industry: 'Logistics', employees: 1480, city: 'Atlanta' },
  { name: 'Larkspur Biotech', domain: 'larkspurbio.test', industry: 'Pharma Logistics', employees: 620, city: 'San Diego' },
  { name: 'Hollowbrook Data', domain: 'hollowbrookdata.test', industry: 'SaaS', employees: 290, city: 'Dublin' },
  { name: 'Emberline Payments', domain: 'emberlinepay.test', industry: 'Payments', employees: 1050, city: 'Singapore' },
  { name: 'Foxglove Distribution', domain: 'foxglovedist.test', industry: 'Distribution', employees: 1720, city: 'Leeds' },
  { name: 'Stanmore Logistics', domain: 'stanmorelog.test', industry: 'Third-party Logistics', employees: 2450, city: 'Chicago' },
  { name: 'Wrenfield Grocers', domain: 'wrenfield.test', industry: 'Food Distribution', employees: 1380, city: 'Nashville' },
  { name: 'Calloway Risk', domain: 'callowayrisk.test', industry: 'Insurance', employees: 830, city: 'Toronto' },
  { name: 'Beacon Hill Analytics', domain: 'beaconhillanalytics.test', industry: 'SaaS', employees: 360, city: 'Boston' },
  { name: 'Dunmore Cold Storage', domain: 'dunmorecold.test', industry: 'Food Distribution', employees: 450, city: 'Omaha' },
  { name: 'Ravensworth Bank', domain: 'ravensworthbank.test', industry: 'Banking', employees: 4600, city: 'Manchester' },
  { name: 'Pemberton Retail Group', domain: 'pembertonretail.test', industry: 'Retail', employees: 3200, city: 'Hamburg' },
  { name: 'Astral Fulfilment', domain: 'astralfulfil.test', industry: 'Third-party Logistics', employees: 990, city: 'Columbus' },
  { name: 'Greyfell Industrial', domain: 'greyfell.test', industry: 'Manufacturing', employees: 2750, city: 'Cleveland' },
  { name: 'Windrose Commerce', domain: 'windrosecommerce.test', industry: 'E-commerce', employees: 640, city: 'Utrecht' },
  { name: 'Sorrel Health Systems', domain: 'sorrelhealth.test', industry: 'Healthcare', employees: 5100, city: 'Philadelphia' },
  { name: 'Kingsley Mutual', domain: 'kingsleymutual.test', industry: 'Insurance', employees: 1900, city: 'Des Moines' },
  { name: 'Auburn Ridge Foods', domain: 'auburnridge.test', industry: 'Food Distribution', employees: 870, city: 'Sacramento' },
  { name: 'Thackeray Payments', domain: 'thackeraypay.test', industry: 'Payments', employees: 1420, city: 'Dublin' },
  { name: 'Norwood Freight', domain: 'norwoodfreight.test', industry: 'Logistics', employees: 2300, city: 'Newark' },
  { name: 'Fairholme Data Group', domain: 'fairholmedata.test', industry: 'SaaS', employees: 410, city: 'Vancouver' },
  { name: 'Belmont Warehousing', domain: 'belmontwarehouse.test', industry: 'Distribution', employees: 1580, city: 'Indianapolis' },
  { name: 'Crestwood Pharma', domain: 'crestwoodpharma.test', industry: 'Pharma Logistics', employees: 3300, city: 'Copenhagen' },
  { name: 'Idlewood Retail', domain: 'idlewoodretail.test', industry: 'Retail', employees: 700, city: 'Minneapolis' },
  { name: 'Sterling Vale Bank', domain: 'sterlingvale.test', industry: 'Banking', employees: 2800, city: 'Singapore' },
  { name: 'Whitmore Logistics', domain: 'whitmorelog.test', industry: 'Third-party Logistics', employees: 1120, city: 'Louisville' },
  { name: 'Ambergate Insurance', domain: 'ambergateins.test', industry: 'Insurance', employees: 2400, city: 'Bristol' },
  { name: 'Lockridge Manufacturing', domain: 'lockridgemfg.test', industry: 'Manufacturing', employees: 1650, city: 'Milwaukee' },
  { name: 'Verdant Grocery Partners', domain: 'verdantgrocery.test', industry: 'Food Distribution', employees: 1230, city: 'Charlotte' },
  { name: 'Ashby Commerce Cloud', domain: 'ashbycommerce.test', industry: 'E-commerce', employees: 350, city: 'Malmö' },
  { name: 'Penwarden Capital', domain: 'penwarden.test', industry: 'Banking', employees: 960, city: 'Dublin' },
  { name: 'Rookwood Distribution', domain: 'rookwooddist.test', industry: 'Distribution', employees: 2150, city: 'St. Louis' },
  { name: 'Halbrook Analytics', domain: 'halbrookanalytics.test', industry: 'SaaS', employees: 270, city: 'Ottawa' },
  { name: 'Ellisfield Cold Chain', domain: 'ellisfieldcold.test', industry: 'Pharma Logistics', employees: 540, city: 'Zurich' },
  { name: 'Marchmont Retail', domain: 'marchmontretail.test', industry: 'Retail', employees: 1850, city: 'Glasgow' },
  { name: 'Kentmere Freight', domain: 'kentmerefreight.test', industry: 'Logistics', employees: 1340, city: 'Salt Lake City' },
  { name: 'Barrowfield Foods', domain: 'barrowfieldfoods.test', industry: 'Food Distribution', employees: 990, city: 'Cork' },
  { name: 'Anselm Risk Partners', domain: 'anselmrisk.test', industry: 'Insurance', employees: 1470, city: 'Zurich' },
  { name: 'Drayton Fulfilment', domain: 'draytonfulfil.test', industry: 'Third-party Logistics', employees: 2050, city: 'Fort Worth' },
  { name: 'Selby Industrial Group', domain: 'selbyindustrial.test', industry: 'Manufacturing', employees: 3600, city: 'Sheffield' },
  { name: 'Windermere Payments', domain: 'windermerepay.test', industry: 'Payments', employees: 780, city: 'Belfast' },
  { name: 'Tanglewood Commerce', domain: 'tanglewoodcommerce.test', industry: 'E-commerce', employees: 460, city: 'Eindhoven' },
  { name: 'Rosecliff Bank', domain: 'rosecliffbank.test', industry: 'Banking', employees: 4200, city: 'Singapore' },
  { name: 'Havelock Warehousing', domain: 'havelockwarehouse.test', industry: 'Distribution', employees: 1290, city: 'Tulsa' },
  { name: 'Kirkby Data Works', domain: 'kirkbydata.test', industry: 'SaaS', employees: 320, city: 'Leeds' },
  { name: 'Ferncroft Grocers', domain: 'ferncroftgrocers.test', industry: 'Food Distribution', employees: 1560, city: 'Richmond' },
  { name: 'Aldwych Assurance', domain: 'aldwychassurance.test', industry: 'Insurance', employees: 2900, city: 'London' },
  { name: 'Bramley Logistics', domain: 'bramleylogistics.test', industry: 'Third-party Logistics', employees: 1740, city: 'Jacksonville' },
  { name: 'Coldharbour Pharma', domain: 'coldharbourpharma.test', industry: 'Pharma Logistics', employees: 2600, city: 'Leiden' },
  { name: 'Netherby Retail', domain: 'netherbyretail.test', industry: 'Retail', employees: 1080, city: 'Gothenburg' },
  { name: 'Ormsby Manufacturing', domain: 'ormsbymfg.test', industry: 'Manufacturing', employees: 2250, city: 'Toledo' },
] as const

export const FIRST_NAMES: readonly string[] = [
  'Amara', 'Daniel', 'Priya', 'Tomas', 'Aisha', 'Marcus', 'Lena', 'Rafael', 'Yuki', 'Isabelle',
  'Omar', 'Freya', 'Diego', 'Nadia', 'Callum', 'Mei', 'Ivan', 'Sofia', 'Kwame', 'Elena',
  'Hassan', 'Greta', 'Andre', 'Ana', 'Josef', 'Rina', 'Miles', 'Claudia', 'Nikhil', 'Astrid',
  'Theo', 'Zara', 'Lucas', 'Imani', 'Henrik', 'Camille', 'Arjun', 'Beatriz', 'Soren', 'Naomi',
] as const

export const LAST_NAMES: readonly string[] = [
  'Okonkwo', 'Ferreira', 'Raghunathan', 'Lindqvist', 'Bello', 'Hartley', 'Novak', 'Delgado',
  'Tanaka', 'Moreau', 'Haddad', 'Bergstrom', 'Cabrera', 'Vasquez', 'Whitfield', 'Chen',
  'Petrov', 'Almeida', 'Mensah', 'Kowalski', 'Rahman', 'Lindgren', 'Duarte', 'Bianchi',
  'Novotny', 'Sharma', 'Callahan', 'Rossi', 'Iyer', 'Sundberg', 'Bakker', 'Adeyemi',
  'Costa', 'Nakamura', 'Olsen', 'Laurent', 'Kapoor', 'Santos', 'Eriksen', 'Fitzgerald',
] as const

export const TITLES: readonly string[] = [
  'VP Operations', 'Head of Data Platform', 'Director of Analytics', 'Chief Technology Officer',
  'VP Data', 'Head of BI', 'Data Engineering Manager', 'Director of Fulfilment',
  'Head of Warehouse Automation', 'Operations Director', 'Head of Cold Chain',
  'Head of Compliance', 'Chief Information Security Officer', 'Director of Risk',
  'VP Engineering', 'Head of Supply Chain', 'Director of IT', 'VP Finance',
] as const

/** Pain points, keyed loosely to what each client sells. */
export const PAIN_POINTS: readonly string[] = [
  'warehouse spend climbing faster than query volume',
  'six-week lead times on every new analytics request',
  'pallet throughput capped by a fixed racking layout',
  'audit evidence still collected by hand in spreadsheets',
  'cold-chain excursions discovered days after the fact',
  'three separate BI tools reporting three different revenue numbers',
  'peak-season labour costs eating the fulfilment margin',
  'a compliance backlog that grows every quarter',
] as const

/** Observable "why now" hooks a research agent would plausibly surface. */
export const SIGNALS: readonly string[] = [
  'hiring across operations and data roles',
  'opening a second distribution hub',
  'expanding into two new regions this year',
  'consolidating onto a single reporting stack',
  'rolling out automation across the main site',
  'renewing your compliance certifications',
] as const

export const SUBJECT_TEMPLATES: readonly string[] = [
  '{firstName} — quick question about {company}',
  '{company} + a 40% smaller warehouse bill',
  'Idea for {company}’s {shortPain}',
  '{firstName}, worth 10 minutes?',
  'Re: {company} scaling plans',
  'Saw {company} is hiring in ops',
] as const

export const FOLLOWUP_SUBJECT_PREFIX = 'Re: '

export const OPENING_TEMPLATES: readonly string[] = [
  'Hi {firstName},\n\nI came across {company} while looking at {industry} teams in {city}, and noticed you’re {signal}.',
  'Hi {firstName},\n\n{company} showing up in the {industry} rankings this quarter is what put you on my radar — congrats on the {signal}.',
  '{firstName} — I’ll keep this short.\n\nMost {industry} teams around {employees} people hit the same wall: {painPoint}.',
] as const

export const PITCH_TEMPLATES: readonly string[] = [
  'Teams your size usually run into {painPoint} right about now. {valueProp}',
  '{valueProp} That normally matters most when {painPoint} starts showing up in the monthly numbers.',
  'The reason I’m reaching out: {valueProp} We see {painPoint} at almost every company at your stage.',
] as const

export const CLOSING_TEMPLATES: readonly string[] = [
  'Worth a 15-minute look? Happy to send over the numbers first if that’s easier.\n\n— {senderName}',
  'If it’s relevant, here’s my calendar: {bookingLink}\n\n— {senderName}',
  'Open to a quick call next week? No deck, just the before/after.\n\n— {senderName}',
] as const

export const FOLLOWUP_BODIES: readonly string[] = [
  'Hi {firstName},\n\nFloating this back to the top of your inbox in case it got buried. Still happy to walk through how we handled {painPoint} for a team about {employees} strong.\n\n— {senderName}',
  '{firstName} — one more nudge and then I’ll leave you alone.\n\nIf {painPoint} isn’t on your plate this quarter, just say "not now" and I’ll circle back in six months.\n\n— {senderName}',
  'Hi {firstName},\n\nLast note from me. If someone else at {company} owns this, I’d be glad to be pointed their way.\n\n— {senderName}',
] as const

export type ReplyIntent = 'interested' | 'question' | 'price' | 'opt_out' | 'not_now'

export interface ReplyFixture {
  readonly intent: ReplyIntent
  readonly body: string
}

export const REPLY_FIXTURES: readonly ReplyFixture[] = [
  {
    intent: 'interested',
    body: 'Thanks for reaching out — this is timely. We’re re-platforming in Q4 and this is squarely on my list. Can you do Thursday afternoon?',
  },
  {
    intent: 'interested',
    body: 'Interesting. I’d want my platform lead in the room too. Send over a couple of slots and I’ll get it in the diary.',
  },
  {
    intent: 'question',
    body: 'Before we book anything — do you support on-prem deployments, or is this cloud-only? That’s a hard requirement for us.',
  },
  {
    intent: 'question',
    body: 'How long does a typical rollout take, and what does it need from my team during that window?',
  },
  {
    intent: 'price',
    body: 'Sounds relevant. What does this actually cost for a team our size? I’d rather know the range before spending time on a call.',
  },
  {
    intent: 'price',
    body: 'Can you send pricing? If it’s over our threshold there’s no point booking time.',
  },
  {
    intent: 'not_now',
    body: 'Not a priority this quarter — budget is locked. Try me again in the new year.',
  },
  {
    intent: 'opt_out',
    body: 'Please remove me from this list and don’t contact me again.',
  },
] as const

export const REPLY_OUTBOUND_TEMPLATES: Readonly<Record<ReplyIntent, string>> = {
  interested:
    'Great — Thursday works. I’ve sent an invite to this address with a dial-in.\n\nAhead of it, is there a specific number you’re trying to move? I’ll pull the closest comparable we have.\n\n— {senderName}',
  question:
    'Good question. Both are supported — most teams start cloud and a handful run the collector in their own VPC, which is what I’d suggest given your setup.\n\nWant me to walk through the second option on a call?\n\n— {senderName}',
  price:
    'Completely fair. Pricing scales with volume rather than seats, so the honest answer needs two numbers from you.\n\nI’ve looped in my colleague who can give you a firm range — they’ll follow up directly.\n\n— {senderName}',
  not_now:
    'Understood — I’ll make a note and come back to you in the new year. Good luck with the quarter.\n\n— {senderName}',
  opt_out:
    'Removed — you won’t hear from me again. Apologies for the interruption.\n\n— {senderName}',
} as const

export const KNOWLEDGE_TEMPLATES: Readonly<Record<'company' | 'person' | 'news' | 'pain_point', readonly string[]>> = {
  company: [
    '{company} is a {industry} business headquartered in {city} with roughly {employees} employees.',
    '{company} runs its own fulfilment network rather than outsourcing, per the operations page on their site.',
    '{company} lists {industry} compliance certifications on its trust page, renewed within the last year.',
  ],
  person: [
    '{fullName} has held the {title} role at {company} since 2024, previously in a similar post elsewhere in {industry}.',
    '{fullName} ({title}) spoke on a supply-chain panel about automation payback periods.',
    '{fullName} is listed as the {title} on {company}’s leadership page.',
  ],
  news: [
    '{company} announced an expansion into a second distribution hub, citing capacity constraints.',
    '{company} reported double-digit volume growth in its most recent trading update.',
    '{company} is hiring across operations and data roles, per its careers page.',
  ],
  pain_point: [
    'Job listings at {company} repeatedly mention {painPoint}, suggesting it is an active internal priority.',
    'A published case study from {company} describes {painPoint} as the constraint on their last expansion.',
    '{company} leadership referenced {painPoint} in a recent trade-press interview.',
  ],
} as const

export const KNOWLEDGE_REQUEST_QUESTIONS: readonly string[] = [
  'They asked whether we support on-prem deployment. What is the current answer?',
  'They want to know if there is a published SOC 2 Type II report we can share pre-contract.',
  'They asked for a reference customer in cold-chain specifically. Do we have one we can name?',
  'They asked what happens to their data if they churn. What is the retention policy?',
  'They want to know the minimum contract length. Is 12 months still the floor?',
  'They asked whether the pilot fee is credited against the annual contract.',
] as const

export const KNOWLEDGE_REQUEST_ANSWERS: readonly string[] = [
  'Yes — self-hosted collector in their VPC, control plane stays with us. Standard for regulated buyers.',
  'Type II is available under NDA. Send the mutual NDA first, then the report.',
  'Confirmed 12 months minimum. Pilot fee is credited in full against year one.',
] as const

export const EVENT_ACTORS: readonly string[] = ['pipeline', 'agent', 'cron', 'operator'] as const

# Uniforms Fashion — 8-Campaign ICP Spec

Client: **Uniforms Fashion** (`d99edf8f-b185-47b2-9615-1f6e43853001`, domain `uniformsfashion.com`, already exists in `clients`, no campaigns yet as of 2026-08-06).

Source: operator's handwritten 9-sector target list (photo, 2026-08-06), narrowed by a second client update (photo with strikethroughs, 2026-08-06, confirmed via follow-up questions) — Sheriff Offices, State Police, Fire Departments, EMS, National Guard, Logistics Companies, Warehouses, Manufacturing Facilities, Event Venues, Convention Centers, Cleaning Companies, and Pest Control Companies were all cut from their respective campaigns, healthcare was narrowed to Hospitals only, and the entire Industrial Sector campaign (#7) was cancelled. **9 sectors → 8 campaigns.** Site research: 28 years in-house uniform manufacturing (est. 1997), Istanbul (Sultangazi) production facility with cutting + warehouse + production floor, custom measurement/fitting, design & fabric selection, currently serving Aviation / Military & Police / Tourism-Hospitality / Corporate / Ceremonial verticals. These campaigns are new-vertical expansion targets.

## How these fields are actually used (read from the pipeline code, 2026-08-06)

- `personTitles` → Apollo's native `person_titles[]` filter (server-side, OR'd by Apollo).
- `keywords` → **Apollo's `q_keywords` is a single free-text field, not an OR-list.** Confirmed live 2026-08-06 (see `src/lib/pipeline/discover.ts` header comment and `scripts/test-apollo-schools-search.ts`): joining multiple keywords returns `total_entries: 0` or HTTP 422. The pipeline (`searchTargets`/`icpForTarget` in `discover.ts`) cycles through `keywords` **one at a time**, moving to the next only once the current one's page comes back empty (or quota is hit). So a long keyword list is fine — it's coverage across many searches/days, not a single boolean query — but a broad early keyword can dominate a given run's budget (`MAX_SEARCH_PAGES = 20` calls per pass).
- `excludeKeywords` → **not sent to Apollo** (no server-side exclude param exists). Matched client-side, whole-word, against organization name + person title pre-enrich, and additionally against `organizationIndustry` + `organizationDescription` post-enrich (`src/lib/apollo/exclude-keywords.ts`).
- `organizationLocations` → Apollo's native filter. All 9 below assume `united states` (the sub-category vocabulary — Sheriff's Office, county jail, National Guard, EMS — is US-specific). Widen/change per campaign in the form if targeting other countries.
- `personSeniorities` → left empty on all 9. Apollo's seniority enum tagging is unreliable on titles like "Quartermaster" or "Warden" and risks silently dropping valid matches.

**Person titles — revised 2026-08-06, tightened to precise buyer titles only** (operator request: reach the exact person who owns uniform purchasing, not generic ops/exec leadership). Dropped across every campaign: VP of Operations, Director of Operations, Chief Operating Officer, General Manager, Owner, Chief Security Officer, Director of Security, Finance Director/Manager (approves budget, doesn't place the order), Business Development Director, Vendor Management Director, Fleet Readiness Manager, Administrative Services Director. Kept only procurement/purchasing/supply-chain roles plus the sector-specific title that is the literal functional owner of uniforms (Quartermaster, Uniform Coordinator, Business Manager/Bursar for schools, Executive Housekeeper for hotels, Materials Manager for healthcare, HSE Manager for industrial).

## Suggested shared settings

| Field | Value |
|---|---|
| Organization locations | `united states` |
| Daily target | `15` per campaign to start (9×15 = 135/day total vs. 9×50 default — a sane pilot before scaling) |
| Person seniorities | none checked |
| Contact email statuses | default (`verified`) |
| Booking link | not sourced from the site — operator must supply per campaign |

---

## 1. Public Safety Agencies

Police, Corrections/Jails, Private Security. **Client cut Sheriff Offices, State Police, Fire Departments, and EMS on 2026-08-06** (handwritten list update, strikethrough) — those four sub-verticals are removed below.

**Value prop:** We manufacture duty uniforms, dress uniforms, and outerwear in-house for police and corrections agencies — custom insignia, agency-specific colors, and fleet-wide replacement with consistent sizing across every recruit class. 28 years producing to spec, direct from our own cutting and production floor, not a reseller markup.

**Person titles:**
```
procurement officer, procurement manager, procurement director, purchasing manager, purchasing agent, purchasing officer, purchasing coordinator, supply chain manager, quartermaster, supply officer, uniform coordinator, uniform program manager, support services manager
```

**Keywords:**
```
police department, county jail, correctional facility, department of corrections, detention center, juvenile detention center, private security company, security guard company, security services company, law enforcement agency, public safety department, correctional officer academy
```

**Exclude keywords:**
```
security software, cybersecurity, cyber security, it security, managed security services, security systems installation, alarm company, camera systems, video surveillance software, staffing agency, recruiting agency, executive search, law firm, attorney, bail bonds, background check company, security consulting, security training software
```

---

## 2. Border & Transit Security

Customs/Border, Border Patrol, Airport/Transit Police, University Police, Port Authorities, Government Security.

**Value prop:** Custom-manufactured field and post uniforms for border, customs, airport, transit, and port security operations — engineered for long shifts and all-weather posts, with agency insignia embroidery. We produce in-house, so a fleet-wide reorder or a new hire class never waits on a reseller's backorder.

**Person titles:**
```
procurement director, procurement manager, procurement officer, purchasing manager, purchasing officer, purchasing coordinator, supply chain manager, contracts manager, contracting officer, quartermaster, uniform program manager, uniform coordinator
```

**Keywords:**
```
customs and border protection, border patrol, border security agency, airport police, airport authority, airport security, transportation security, federal law enforcement agency, immigration enforcement agency, customs agency, checkpoint security, transportation authority
```

**Removed 2026-08-15 from the live DB campaign** (no matching email sample yet — see [Keyword cleanup](#keyword-cleanup--2026-08-15-deleted-from-the-live-db-campaigns) at the bottom of this doc):
```
transit police department, university police department, campus security department, port authority, harbor patrol, seaport security, marine police, government security agency, rail transit police, metro transit authority
```

**Exclude keywords:**
```
security software, cybersecurity, border security software, biometric software vendor, staffing agency, recruiting agency, consulting, travel agency, freight forwarder, customs brokerage software, logistics software, insurance broker, law firm, immigration law firm, visa services, security systems installation
```

---

## 3. Defense & Military

Military/Defense Contractors, Armed Forces suppliers, Coast Guard suppliers, Aerospace & Defense. **Client cut National Guard on 2026-08-06.**

**Value prop:** In-house production of tactical, dress, and ceremonial uniforms for defense contractors, National Guard units, and coast guard suppliers — custom insignia, rank markings, and unit patches produced to spec with the fabric durability and sizing consistency defense procurement requires.

**Person titles:**
```
procurement director, procurement manager, purchasing manager, contracting officer, contracts manager, supply chain director, materiel manager, quartermaster, sustainment manager, uniform program manager, acquisition manager
```

**Keywords:**
```
defense contractor, military contractor, armed forces supplier, military apparel supplier, tactical gear manufacturer, defense logistics company, government contractor, military outfitter, uniform contractor, defense equipment supplier, shipbuilding defense contractor, army surplus supplier, veteran affairs contractor, homeland security contractor, defense procurement agency, military base contractor, defense sustainment company
```

**Removed 2026-08-15 from the live DB campaign** (no matching email sample yet):
```
aerospace and defense company, coast guard supplier
```

**Exclude keywords:**
```
defense software, cybersecurity, weapons manufacturer, ammunition manufacturer, firearms retailer, video game developer, defense consulting, staffing agency, recruiting agency, veteran non-profit, veteran charity, insurance broker, law firm, government relations firm, lobbying firm, think tank
```

---

## 4. Private Sector — Transport & Utilities

Airlines, Airports, Railroads, Transit Companies, Public Utilities (Electric/Water/Gas). **Client cut Logistics Companies, Warehouses, and Manufacturing Facilities on 2026-08-06** — renamed from "Transport, Logistics & Utilities" accordingly.

**Value prop:** Custom-manufactured operational uniforms for airlines, airports, rail, transit, and utility operations — branded, durable, and produced in-house at consistent sizing across large fleets of ground crew and field staff.

**Person titles:**
```
procurement director, procurement manager, purchasing manager, purchasing director, supply chain director, supply chain manager, uniform program manager, employee uniform program manager, fleet manager, facilities manager
```

**Keywords:**
```
airline, ground handling company, airport operator, airport ground services, railroad company, rail operator, freight railway, public transit company, transit authority, bus transit company
```

**Removed 2026-08-15 from the live DB campaign** (no matching email sample yet — Public Utilities has zero coverage):
```
electric utility company, water utility company, natural gas utility, public utility company, municipal utility, energy distribution company, gas distribution company
```

**Exclude keywords:**
```
logistics software, transportation software, fleet management software, staffing agency, recruiting agency, freight brokerage, consulting firm, insurance broker, law firm, travel agency, ride sharing app, delivery app, e-commerce marketplace, financial services, media company, market research firm
```

---

## 5. Hospitality & Tourism

Hotels, Resorts, Casinos, Cruise Lines. **Client cut Event Venues and Convention Centers on 2026-08-06.**

**Value prop:** In-house tailored front-of-house and back-of-house uniforms for hotels, resorts, casinos, and cruise lines — from reception and concierge to housekeeping and F&B, produced to your brand's exact colors and fabric with consistent fit across every property.

**Person titles:**
```
uniform manager, uniform coordinator, director of purchasing, purchasing manager, procurement manager, procurement director, executive housekeeper, director of housekeeping, hr manager
```

**Keywords:**
```
hotel, resort, luxury resort, boutique hotel, hotel chain, hospitality group, cruise line, cruise ship operator, tourism company, tour operator, hospitality management company, hotel management company, spa resort, golf resort, ski resort
```

**Removed 2026-08-15 from the live DB campaign** (no matching email sample yet):
```
casino, casino resort, gaming resort
```

**Exclude keywords:**
```
travel agency, booking platform, hotel software, property management software, staffing agency, recruiting agency, consulting firm, hospitality training school, hospitality school, event planning software, marketing agency, review platform, vacation rental platform, timeshare
```

---

## 6. Healthcare Sector

Hospitals only. **Client cut Medical Centers, Clinics, Dental Groups, Nursing Homes, Assisted Living, and Ambulance Companies on 2026-08-06** (confirmed by operator) — every healthcare sub-vertical except hospitals is gone. `home health agency`, `hospice`, `dialysis center`, and `physical therapy clinic` were never on the client's list at all (my own additions) and are dropped too, since they're all in the same now-cut outpatient/long-term-care cluster.

**Value prop:** Custom scrubs and clinical staff uniforms manufactured in-house for hospitals — durable, easy-care fabrics, consistent sizing across every department, and bulk reorders that don't wait on a distributor's backorder.

**Person titles:**
```
procurement manager, procurement director, purchasing manager, purchasing director, supply chain manager, supply chain director, materials manager, uniform coordinator, environmental services director, director of support services
```

**Keywords:**
```
hospital, health system
```

**Restored 2026-08-15** — removed earlier the same day (no matching email sample), then put back on operator request before any sample was written. Still no matching email sample for Hospitals as of this writing; restored as-is rather than left empty.

**Exclude keywords:**
```
health insurance, medical billing software, healthcare software, electronic health records, telehealth platform, pharmaceutical company, biotech company, medical device manufacturer, staffing agency, recruiting agency, healthcare consulting, medical school, nursing school, health non-profit, patient advocacy, health research institute
```

---

## 7. Industrial Sector — CANCELLED

**Client removed the entire Industrial Sector campaign on 2026-08-06** (confirmed by operator) — Construction, Oil & Gas, Mining, Chemical Plants, Energy, and Telecom Field Services are all out. Not creating this one. Kept as a numbered placeholder only so this doc still maps 1:1 to the client's original 9-slot handwritten list; **8 campaigns total** now go live, not 9.

---

## 8. Retail & Service

Supermarkets, Restaurant Chains, Fast Food, Facilities Management, Delivery/Courier. **Client cut Cleaning Companies and Pest Control Companies on 2026-08-06** — also dropped the closely-related "janitorial services" and "sanitation services" keywords for consistency (same cluster).

**Drift found 2026-08-15:** the 2026-08-06 cut above was never applied to the live DB campaign — `cleaning company`, `janitorial services`, and `pest control` were still live keywords (along with several undocumented variants: `supermarket`, `grocery chain`, `fast food`, `coffee chain`, `facility management`, `courier`, `logistics provider`), so the live keyword list had drifted to 29 entries against this doc's documented 20. Corrected as part of today's cleanup below — the live DB now matches this doc exactly.

**Value prop:** Custom, wash-durable staff uniforms manufactured in-house for supermarkets, restaurant chains, facilities management, and courier operations — branded across every location, produced at the scale multi-site retail and service brands need without distributor lead times.

**Person titles:**
```
procurement manager, procurement director, purchasing manager, purchasing director, supply chain manager, uniform program manager, brand standards manager, route operations manager, fleet manager
```

**Keywords:**
```
delivery company, last mile delivery company, courier company, courier, parcel delivery company, package delivery service, messenger service, food delivery logistics, grocery delivery service, logistics provider
```

**Removed 2026-08-15 from the live DB campaign** (no matching email sample yet — only Delivery/Courier is covered, by "Cargo & Courier"; every Supermarkets/Restaurant Chains/Fast Food/Facilities Management keyword is gone, including the undocumented drift entries found above):
```
supermarket chain, supermarket, grocery store chain, grocery chain, retail chain, restaurant chain, fast food chain, fast food, quick service restaurant, casual dining chain, coffee chain, franchise restaurant group, catering company, food service company, facilities management company, facility management, cleaning company, janitorial services, pest control
```

**Exclude keywords:**
```
delivery app, food delivery app, gig economy platform, e-commerce platform, staffing agency, recruiting agency, marketing agency, consulting firm, point of sale software, restaurant software, inventory software, insurance broker, law firm, franchise consulting, real estate firm, media company, advertising agency, retail analytics software
```

---

## 9. K-12 Schools

School uniform buyers — private, charter, independent, religious, international.

Keywords/exclude-keywords are the **exact, already-live-tested ICP** from `scripts/test-apollo-schools-search.ts` (real Apollo `total_entries` per keyword confirmed 2026-08-06, no reveal credits spent). Briefly removed 2026-08-15 (no matching email sample) then restored the same day on operator request — see the note under Keywords. Run `pnpm test:apollo-schools` for a fresh per-keyword breakdown. Person titles below are narrower than the script's (which reached for principal/head-of-school/superintendent as broader budget-approval leadership) — trimmed to the person who actually places the uniform order, per the 2026-08-06 precision request; if that undershoots quota, the script's broader title set is the fallback.

**Value prop:** Custom school uniforms manufactured in-house — blazers, polos, skirts, trousers, and PE kits produced to your school's exact colors and crest, with consistent sizing across every grade and bulk reorders ready before the new term, not weeks after.

**Person titles:**
```
business manager, bursar, purchasing manager, purchasing officer, purchasing coordinator, procurement manager, procurement officer, finance manager, finance director, facilities manager, operations manager
```

**Keywords:**
```
private school, independent school, charter school, K-12 school, K12, elementary school, primary school, middle school, junior high school, secondary school, high school, international school, boarding school, day school, academy, preparatory school, prep school, grammar school, faith-based school, religious school, catholic school, christian school, islamic school, jewish school, montessori school, IB school, bilingual school, magnet school, public school district, school district, education trust, education group, educational institution
```

**Restored 2026-08-15** — removed earlier the same day (no matching email sample), then put back on operator request before any sample was written. Still no matching email sample for K-12 Schools as of this writing; restored as-is rather than left empty.

**Exclude keywords:**
```
college, university, higher education, tutoring, tutoring center, online school, virtual school, edtech, education software, software, saas, recruiting, staffing, consulting, language school, driving school, music school, dance school, coding bootcamp, training center, test prep, coaching institute
```

---

## Keyword cleanup — 2026-08-15 (deleted from the live DB campaigns)

Cross-referenced the 8 live campaigns' `icp.keywords` against the 10 hand-written formal-intro email samples the operator supplied (Official Institution, Otel & Resort, Travel agencies/Tour operators/Cruise, Customs and Border, Airport Security, Airport & Ground Handling, Rail & Public Transport, Airline, Cargo & Courier, Defence Prime Contractor). Any keyword whose sub-vertical has **no matching sample** was deleted directly from the live `campaigns.icp.keywords` column via a one-off admin script (Supabase service-role client, per-campaign `icp` fetched, `keywords` replaced, every other `icp` field — `personTitles`, `excludeKeywords`, `organizationLocations`, `employeeRangeMin/Max`, `personSeniorities`, `contactEmailStatuses` — left untouched). Verified by re-reading each campaign back from the DB after the write. `personTitles` and `excludeKeywords` were not touched — only `keywords`. Deleted keywords are logged per-campaign above, next to what each campaign kept, so any of this can be restored once a matching sample exists.

**Update — same day, later:** those 10 samples are now wired into the pipeline as real per-campaign email templates, not just a keyword cross-reference. The email-style feature was renamed to email templates and given a per-campaign override (`campaigns.email_template_id`, migration 0046); 6 of these 8 campaigns were assigned a template seeded from the operator's exact wording above — Public Safety Agencies ← Official Institution, Border & Transit Security ← Customs and Border + Airport Security, Defense & Military ← Defence Prime Contractor (its blank capacity bullet dropped, no figure was ever supplied), Private Sector — Transport & Utilities ← Airport & Ground Handling + Rail & Public Transport + Airline, Hospitality & Tourism ← Otel & Resort + Travel/Tour/Cruise, Retail & Service ← Cargo & Courier. Healthcare Sector and K-12 Schools still have zero sample coverage and were left on the client-level default template, unchanged. See `.claude/roadmap.md` 2026-08-15 and `scripts/seed-uniforms-fashion-email-templates.ts`.

**Per-campaign counts (kept → removed):**

| Campaign | Kept | Removed |
|---|---|---|
| 1. Public Safety Agencies | 12 | 0 |
| 2. Border & Transit Security | 12 | 10 |
| 3. Defense & Military | 17 | 2 |
| 4. Private Sector — Transport & Utilities | 10 | 7 |
| 5. Hospitality & Tourism | 15 | 3 |
| 6. Healthcare Sector | 2 | 0 *(restored same day, see below)* |
| 8. Retail & Service | 10 | 19 |
| 9. K-12 Schools | 33 | 0 *(restored same day, see below)* |

**Restored 2026-08-15, same day:** Healthcare Sector's and K-12 Schools' keywords were put back on operator request before any matching email sample existed. Both still have zero email-sample coverage as of this writing — restoring was a deliberate choice to keep those two campaigns discoverable rather than leave them silently empty; the "no sample yet" gap itself is unchanged. Every other campaign's trim above stands.

**Not touched:** campaigns themselves (all 8 still exist, per operator instruction not to delete any), `personTitles`, `excludeKeywords`, value props, and every other `icp` field.

**Two pre-existing findings surfaced while doing this** (not caused by this cleanup, found because it required reading the live DB directly):
- **Campaign 8 drift:** the 2026-08-06 "cut Cleaning Companies and Pest Control" decision (see campaign 8's section above) had never been applied to the live DB — `cleaning company`, `janitorial services`, and `pest control` were still live keywords, along with several other undocumented variants (`supermarket`, `grocery chain`, `fast food`, `coffee chain`, `facility management`, `courier`, `logistics provider`) that were never in this doc at all. Corrected as part of this pass — see campaign 8's "Removed" list above, and the live DB now matches this doc's keyword lists exactly for all 8 campaigns.
- **Live status is `paused`, not `active`:** every one of the 8 campaigns is currently `status: 'paused'` in the DB, not `'active'` as the "Status" section below (written 2026-08-06) states. Not changed by this cleanup — flagging only, since it means none of these campaigns are currently spending Apollo/Emailable credits regardless of their keyword lists.

---

## Status — created 2026-08-06

All 8 (campaigns 1–6, 8, 9 — #7 cancelled) have been created in the database, `status: 'active'`, per explicit operator go-ahead. Two overrides applied at creation time, per operator request, on top of the "suggested shared settings" above:

- **Global**, not `united states` — `organizationLocations: []` on every campaign (no country filter).
- **40+ employees**, not unset — `employeeRangeMin: 40`, `employeeRangeMax: 1_000_000` (Apollo only applies an employee filter when both bounds are set; the high ceiling stands in for an open floor).

**Update 2026-08-15:** actual live status is `paused` on all 8 (see "Keyword cleanup" section above) — this section's `'active'` claim is stale.

`booking_link` is `null` on all 8 — still not sourced. Fill in per campaign via `/campaigns/[campaignId]/edit` once the operator supplies a real booking URL. Being `active` means the next QStash `discover-fanout` run spends real Apollo/Emailable credits against all 8 immediately.

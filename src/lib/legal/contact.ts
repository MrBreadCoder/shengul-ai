/**
 * Contact and entity details, carried over verbatim from the previous published
 * policies.
 *
 * These are the only parts of the legal documents that were not rewritten. Do
 * not edit them as a side effect of changing policy copy: the registered entity,
 * the notice address and the addresses a data subject writes to are facts about
 * the business, not drafting choices, and changing them silently breaks the
 * route by which someone exercises a right.
 */

export const LEGAL_ENTITY = 'Exportpoint LLC'

/** Trading name used in the previous documents. */
export const LEGAL_ENTITY_DBA = 'Exportpoint'

/** The product operated by the entity above, and the subject of these documents. */
export const PRODUCT_NAME = 'Shengul AI'

export const CONTACT_EMAIL = 'support@foundersideai.com'

/** From-address for service notices, including notice of changes to these terms. */
export const NOTICE_EMAIL = 'no-reply@foundersideai.com'

export const CONTACT_PHONE = '(+1)+19292141601'

export const CONTACT_ADDRESS_LINES: readonly string[] = [
  'Exportpoint LLC',
  '1209 Mountain Road Place Northeast, Albuquerque, NM 87110',
  'Albuquerque, NM 87110',
  'United States',
]

export const SITE_HOME_URL = 'http://www.foundersideai.com'

/** Single-line postal address, for use inside a sentence. */
export const CONTACT_ADDRESS_INLINE = CONTACT_ADDRESS_LINES.slice(1).join(', ')

/** Governing law and venue, unchanged from the previous terms. */
export const GOVERNING_STATE = 'New Mexico'

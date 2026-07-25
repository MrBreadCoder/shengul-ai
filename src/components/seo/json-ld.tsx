import { serializeJsonLd } from '@/lib/seo/json-ld'

interface JsonLdProps {
  /** A schema.org node or `@graph` document. */
  readonly data: Record<string, unknown>
}

/**
 * Renders a schema.org payload into the document.
 *
 * `dangerouslySetInnerHTML` is required — React escapes text children as HTML
 * entities, which produces invalid JSON inside a `<script>`. The payload is
 * escaped by `serializeJsonLd` instead, which neutralises tag-closing
 * sequences without corrupting the JSON.
 */
export function JsonLd({ data }: JsonLdProps): React.ReactElement {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  )
}

import { Envelope, Plus } from '@phosphor-icons/react/dist/ssr'
import { EmailMessage } from '@/components/email-message'
import { EmptyState } from '@/components/empty-state'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ResourceSummary } from '@/components/resource-list'
import type { ContactThread } from '@/lib/ui/mail-threads'
import type { ComposeContact } from '@/types/mail'
import { ComposeForm } from './compose-form'

interface MailTabProps {
  caseId: string
  threads: readonly ContactThread[]
  newContactOptions: readonly ComposeContact[]
  resources: readonly ResourceSummary[]
  now: Date
}

export function MailTab({
  caseId,
  threads,
  newContactOptions,
  resources,
  now,
}: MailTabProps): React.ReactElement {
  // No contact has been emailed yet: no thread to separate, so this stays
  // the original single-form layout instead of a tab row with one empty tab.
  if (threads.length === 0) {
    return (
      <div className="flex max-w-[80ch] flex-col gap-4">
        <EmptyState
          icon={Envelope}
          title="No mail on this case"
          description="Outbound drafts appear here once the writer agent runs, and replies land automatically when the inbound poller picks them up."
        />
        <ComposeForm caseId={caseId} contacts={newContactOptions} resources={resources} defaultSubject="" />
      </div>
    )
  }

  // length check above (threads.length === 0 returns early) guarantees index 0 exists
  const defaultThreadId = threads[0]!.leadId

  return (
    <Tabs defaultValue={defaultThreadId} className="gap-4">
      <TabsList>
        {threads.map((thread) => (
          <TabsTrigger key={thread.leadId} value={thread.leadId}>
            {thread.fullName}
            <span className="tnum text-faint">{thread.emails.length}</span>
          </TabsTrigger>
        ))}
        {newContactOptions.length > 0 ? (
          <TabsTrigger value="new">
            <Plus size={14} weight="light" />
            New
          </TabsTrigger>
        ) : null}
      </TabsList>

      {threads.map((thread) => (
        <TabsContent key={thread.leadId} value={thread.leadId}>
          <div className="flex max-w-[80ch] flex-col gap-4">
            <div className="flex flex-col gap-3">
              {thread.emails.map((email) => (
                <EmailMessage
                  key={email.id}
                  direction={email.direction}
                  status={email.status}
                  subject={email.subject}
                  body={email.body}
                  sequenceStep={email.sequence_step}
                  timestamp={email.sent_at ?? email.created_at}
                  now={now}
                  sentByHuman={email.sent_by !== null}
                />
              ))}
            </div>
            <ComposeForm
              caseId={caseId}
              contacts={thread.composeContact ? [thread.composeContact] : []}
              resources={resources}
              defaultSubject={thread.defaultSubject}
            />
          </div>
        </TabsContent>
      ))}

      {newContactOptions.length > 0 ? (
        <TabsContent value="new">
          <div className="max-w-[80ch]">
            <ComposeForm caseId={caseId} contacts={newContactOptions} resources={resources} defaultSubject="" />
          </div>
        </TabsContent>
      ) : null}
    </Tabs>
  )
}

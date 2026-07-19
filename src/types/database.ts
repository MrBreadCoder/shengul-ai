// Hand-authored to match supabase/migrations/0001_initial_schema.sql and
// 0002_rls_policies.sql exactly.
// No live Postgres connection was available to run `supabase gen types` — this
// file must be regenerated (`pnpm exec supabase gen types typescript --local`)
// and diffed against this version the first time a local/hosted DB exists.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      clients: {
        Row: {
          id: string
          name: string
          status: Database['public']['Enums']['client_status']
          settings: Json
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          status?: Database['public']['Enums']['client_status']
          settings?: Json
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['clients']['Insert']>
        Relationships: []
      }
      app_users: {
        Row: {
          id: string
          role: Database['public']['Enums']['user_role']
          client_id: string | null
          created_at: string
        }
        Insert: {
          id: string
          role?: Database['public']['Enums']['user_role']
          client_id?: string | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['app_users']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'app_users_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
        ]
      }
      campaigns: {
        Row: {
          id: string
          client_id: string
          name: string
          status: Database['public']['Enums']['campaign_status']
          icp: Json
          value_prop: string | null
          booking_link: string | null
          reply_mode: Database['public']['Enums']['reply_mode']
          price_handoff_mode: Database['public']['Enums']['price_handoff_mode']
          mailbox_ids: string[]
          daily_target: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          name: string
          status?: Database['public']['Enums']['campaign_status']
          icp?: Json
          value_prop?: string | null
          booking_link?: string | null
          reply_mode?: Database['public']['Enums']['reply_mode']
          price_handoff_mode?: Database['public']['Enums']['price_handoff_mode']
          mailbox_ids?: string[]
          daily_target?: number
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['campaigns']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'campaigns_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
        ]
      }
      cases: {
        Row: {
          id: string
          client_id: string
          campaign_id: string
          company_name: string
          company_domain: string | null
          status: Database['public']['Enums']['case_status']
          summary: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          campaign_id: string
          company_name: string
          company_domain?: string | null
          status?: Database['public']['Enums']['case_status']
          summary?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['cases']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'cases_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'cases_campaign_id_fkey'
            columns: ['campaign_id']
            isOneToOne: false
            referencedRelation: 'campaigns'
            referencedColumns: ['id']
          },
        ]
      }
      leads: {
        Row: {
          id: string
          client_id: string
          campaign_id: string
          case_id: string | null
          full_name: string
          title: string | null
          company_name: string | null
          company_domain: string | null
          linkedin_url: string | null
          source: string | null
          raw: Json
          email: string | null
          email_status: Database['public']['Enums']['lead_email_status']
          email_verified_at: string | null
          status: Database['public']['Enums']['lead_status']
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          campaign_id: string
          case_id?: string | null
          full_name: string
          title?: string | null
          company_name?: string | null
          company_domain?: string | null
          linkedin_url?: string | null
          source?: string | null
          raw?: Json
          email?: string | null
          email_status?: Database['public']['Enums']['lead_email_status']
          email_verified_at?: string | null
          status?: Database['public']['Enums']['lead_status']
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['leads']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'leads_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'leads_campaign_id_fkey'
            columns: ['campaign_id']
            isOneToOne: false
            referencedRelation: 'campaigns'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'leads_case_id_fkey'
            columns: ['case_id']
            isOneToOne: false
            referencedRelation: 'cases'
            referencedColumns: ['id']
          },
        ]
      }
      case_knowledge: {
        Row: {
          id: string
          client_id: string
          case_id: string
          kind: Database['public']['Enums']['knowledge_kind']
          content: string
          source_url: string | null
          citation: string | null
          created_by: Database['public']['Enums']['author_kind']
          created_at: string
        }
        Insert: {
          id?: string
          client_id: string
          case_id: string
          kind: Database['public']['Enums']['knowledge_kind']
          content: string
          source_url?: string | null
          citation?: string | null
          created_by?: Database['public']['Enums']['author_kind']
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['case_knowledge']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'case_knowledge_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'case_knowledge_case_id_fkey'
            columns: ['case_id']
            isOneToOne: false
            referencedRelation: 'cases'
            referencedColumns: ['id']
          },
        ]
      }
      emails: {
        Row: {
          id: string
          client_id: string
          case_id: string | null
          lead_id: string | null
          thread_id: string | null
          provider_message_id: string | null
          direction: Database['public']['Enums']['email_direction']
          subject: string | null
          body: string | null
          status: Database['public']['Enums']['email_status']
          sequence_step: number | null
          mailbox_id: string | null
          sent_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          client_id: string
          case_id?: string | null
          lead_id?: string | null
          thread_id?: string | null
          provider_message_id?: string | null
          direction: Database['public']['Enums']['email_direction']
          subject?: string | null
          body?: string | null
          status?: Database['public']['Enums']['email_status']
          sequence_step?: number | null
          mailbox_id?: string | null
          sent_at?: string | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['emails']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'emails_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'emails_case_id_fkey'
            columns: ['case_id']
            isOneToOne: false
            referencedRelation: 'cases'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'emails_lead_id_fkey'
            columns: ['lead_id']
            isOneToOne: false
            referencedRelation: 'leads'
            referencedColumns: ['id']
          },
        ]
      }
      sequences: {
        Row: {
          id: string
          client_id: string
          case_id: string
          lead_id: string
          state: Database['public']['Enums']['sequence_state']
          current_step: number
          next_action_at: string | null
          qstash_message_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          case_id: string
          lead_id: string
          state?: Database['public']['Enums']['sequence_state']
          current_step?: number
          next_action_at?: string | null
          qstash_message_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['sequences']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'sequences_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'sequences_case_id_fkey'
            columns: ['case_id']
            isOneToOne: false
            referencedRelation: 'cases'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'sequences_lead_id_fkey'
            columns: ['lead_id']
            isOneToOne: false
            referencedRelation: 'leads'
            referencedColumns: ['id']
          },
        ]
      }
      knowledge_requests: {
        Row: {
          id: string
          client_id: string
          case_id: string
          lead_id: string | null
          email_id: string | null
          question: string
          status: Database['public']['Enums']['knowledge_req_status']
          human_answer: string | null
          answered_by: string | null
          answered_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          client_id: string
          case_id: string
          lead_id?: string | null
          email_id?: string | null
          question: string
          status?: Database['public']['Enums']['knowledge_req_status']
          human_answer?: string | null
          answered_by?: string | null
          answered_at?: string | null
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['knowledge_requests']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'knowledge_requests_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'knowledge_requests_case_id_fkey'
            columns: ['case_id']
            isOneToOne: false
            referencedRelation: 'cases'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'knowledge_requests_lead_id_fkey'
            columns: ['lead_id']
            isOneToOne: false
            referencedRelation: 'leads'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'knowledge_requests_email_id_fkey'
            columns: ['email_id']
            isOneToOne: false
            referencedRelation: 'emails'
            referencedColumns: ['id']
          },
        ]
      }
      mailboxes: {
        Row: {
          id: string
          client_id: string
          provider: Database['public']['Enums']['mailbox_provider']
          email_address: string
          display_name: string | null
          oauth: Json
          daily_cap: number
          sent_today: number
          warmup_state: Json
          health: Database['public']['Enums']['mailbox_health']
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          provider: Database['public']['Enums']['mailbox_provider']
          email_address: string
          display_name?: string | null
          oauth?: Json
          daily_cap?: number
          sent_today?: number
          warmup_state?: Json
          health?: Database['public']['Enums']['mailbox_health']
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['mailboxes']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'mailboxes_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
        ]
      }
      suppressions: {
        Row: {
          id: string
          client_id: string
          email: string
          reason: Database['public']['Enums']['suppression_reason']
          created_at: string
        }
        Insert: {
          id?: string
          client_id: string
          email: string
          reason: Database['public']['Enums']['suppression_reason']
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['suppressions']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'suppressions_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
        ]
      }
      events: {
        Row: {
          id: string
          client_id: string | null
          case_id: string | null
          actor: string
          type: string
          payload: Json
          created_at: string
        }
        Insert: {
          id?: string
          client_id?: string | null
          case_id?: string | null
          actor: string
          type: string
          payload?: Json
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['events']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'events_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'events_case_id_fkey'
            columns: ['case_id']
            isOneToOne: false
            referencedRelation: 'cases'
            referencedColumns: ['id']
          },
        ]
      }
    }
    Views: Record<string, never>
    Functions: {
      is_operator: {
        Args: Record<string, never>
        Returns: boolean
      }
      current_client_id: {
        Args: Record<string, never>
        Returns: string
      }
    }
    Enums: {
      user_role: 'operator' | 'client'
      client_status: 'active' | 'paused' | 'archived'
      campaign_status: 'active' | 'paused' | 'archived'
      reply_mode: 'auto_send' | 'human_approve' | 'hybrid'
      price_handoff_mode: 'book_call_and_notify' | 'notify_only' | 'configurable'
      lead_email_status: 'unverified' | 'verified' | 'invalid' | 'risky' | 'not_found'
      lead_status: 'new' | 'parked' | 'active'
      case_status:
        | 'new'
        | 'researching'
        | 'ready'
        | 'contacted'
        | 'in_conversation'
        | 'hot_handoff'
        | 'won'
        | 'lost'
        | 'dead'
      knowledge_kind: 'company' | 'person' | 'news' | 'pain_point' | 'answer'
      email_direction: 'outbound' | 'inbound'
      email_status: 'draft' | 'queued' | 'sent' | 'delivered' | 'bounced' | 'failed'
      sequence_state: 'active' | 'paused' | 'stopped' | 'completed'
      knowledge_req_status: 'open' | 'answered' | 'dismissed'
      mailbox_provider: 'gmail' | 'outlook'
      mailbox_health: 'ok' | 'warning' | 'blocked'
      suppression_reason: 'replied' | 'bounced' | 'manual' | 'price_handoff'
      author_kind: 'agent' | 'human'
    }
    CompositeTypes: Record<string, never>
  }
}

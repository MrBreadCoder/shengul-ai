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
          warmup_profile: Database['public']['Enums']['warmup_profile']
          domain: string | null
          logo_url: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          status?: Database['public']['Enums']['client_status']
          settings?: Json
          warmup_profile?: Database['public']['Enums']['warmup_profile']
          domain?: string | null
          logo_url?: string | null
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
          company_key: string
          status: Database['public']['Enums']['case_status']
          summary: string | null
          created_at: string
          updated_at: string
          collision_notified_at: string | null
        }
        Insert: {
          id?: string
          client_id: string
          campaign_id: string
          company_name: string
          company_domain?: string | null
          company_key: string
          status?: Database['public']['Enums']['case_status']
          summary?: string | null
          created_at?: string
          updated_at?: string
          collision_notified_at?: string | null
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
          source_id: string | null
          raw: Json
          email: string | null
          email_status: Database['public']['Enums']['lead_email_status']
          email_verified_at: string | null
          email_verification: Json | null
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
          source_id?: string | null
          raw?: Json
          email?: string | null
          email_status?: Database['public']['Enums']['lead_email_status']
          email_verified_at?: string | null
          email_verification?: Json | null
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
      client_knowledge_sources: {
        Row: {
          id: string
          client_id: string
          source_type: Database['public']['Enums']['knowledge_source_type']
          url: string | null
          storage_path: string | null
          title: string
          content: string | null
          char_count: number | null
          status: Database['public']['Enums']['knowledge_source_status']
          error_message: string | null
          created_by: string
          created_at: string
          scraped_at: string | null
        }
        Insert: {
          id?: string
          client_id: string
          source_type: Database['public']['Enums']['knowledge_source_type']
          url?: string | null
          storage_path?: string | null
          title: string
          content?: string | null
          char_count?: number | null
          status?: Database['public']['Enums']['knowledge_source_status']
          error_message?: string | null
          created_by: string
          created_at?: string
          scraped_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['client_knowledge_sources']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'client_knowledge_sources_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
        ]
      }
      client_knowledge_chunks: {
        Row: {
          id: string
          client_id: string
          source_id: string
          chunk_index: number
          content: string
          embedding: string
          created_at: string
        }
        Insert: {
          id?: string
          client_id: string
          source_id: string
          chunk_index: number
          content: string
          embedding: number[]
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['client_knowledge_chunks']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'client_knowledge_chunks_source_id_fkey'
            columns: ['source_id']
            isOneToOne: false
            referencedRelation: 'client_knowledge_sources'
            referencedColumns: ['id']
          },
        ]
      }
      client_resources: {
        Row: {
          id: string
          client_id: string
          title: string
          description: string
          file_name: string
          mime_type: string
          byte_size: number
          storage_path: string
          is_active: boolean
          created_by: string
          created_at: string
        }
        Insert: {
          id?: string
          client_id: string
          title: string
          description: string
          file_name: string
          mime_type: string
          byte_size: number
          storage_path: string
          is_active?: boolean
          created_by: string
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['client_resources']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'client_resources_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
        ]
      }
      email_attachments: {
        Row: {
          id: string
          client_id: string
          email_id: string
          resource_id: string
          created_at: string
        }
        Insert: {
          id?: string
          client_id: string
          email_id: string
          resource_id: string
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['email_attachments']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'email_attachments_resource_id_fkey'
            columns: ['resource_id']
            isOneToOne: false
            referencedRelation: 'client_resources'
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
          in_reply_to_email_id: string | null
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
          in_reply_to_email_id?: string | null
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
      invite_links: {
        Row: {
          token_hash: string
          user_id: string
          client_id: string
          created_by: string
          expires_at: string
          created_at: string
        }
        Insert: {
          token_hash: string
          user_id: string
          client_id: string
          created_by: string
          expires_at: string
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['invite_links']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'invite_links_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'invite_links_created_by_fkey'
            columns: ['created_by']
            isOneToOne: false
            referencedRelation: 'app_users'
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
          warmup_profile: Database['public']['Enums']['warmup_profile']
          warmup_started_at: string | null
          health: Database['public']['Enums']['mailbox_health']
          health_reason: string | null
          health_changed_at: string | null
          inbound_cursor: string | null
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
          warmup_profile?: Database['public']['Enums']['warmup_profile']
          warmup_started_at?: string | null
          health?: Database['public']['Enums']['mailbox_health']
          health_reason?: string | null
          health_changed_at?: string | null
          inbound_cursor?: string | null
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
          severity: Database['public']['Enums']['log_severity']
          source: Database['public']['Enums']['log_source']
          payload: Json
          created_at: string
        }
        Insert: {
          id?: string
          client_id?: string | null
          case_id?: string | null
          actor: string
          type: string
          severity?: Database['public']['Enums']['log_severity']
          source?: Database['public']['Enums']['log_source']
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
      events_error_counts: {
        Args: { p_since: string }
        Returns: {
          client_id: string
          error_count: number
          warn_count: number
        }[]
      }
      current_client_id: {
        Args: Record<string, never>
        Returns: string
      }
      claim_mailbox_send: {
        Args: { p_mailbox_id: string; p_effective_cap: number }
        Returns: Database['public']['Tables']['mailboxes']['Row'][]
      }
      mailbox_send_stats: {
        Args: { p_since: string }
        Returns: {
          mailbox_id: string
          sent_count: number
          bounced_count: number
        }[]
      }
      reset_mailbox_daily_counters: {
        Args: Record<string, never>
        Returns: undefined
      }
      find_stuck_cases: {
        Args: { p_cutoff: string; p_limit: number }
        Returns: Database['public']['Tables']['cases']['Row'][]
      }
      match_client_knowledge_chunks: {
        Args: { p_client_id: string; p_query_embedding: number[]; p_limit: number }
        Returns: {
          source_id: string
          source_title: string
          content: string
          similarity: number
        }[]
      }
      analytics_overview: {
        Args: { p_from: string; p_to: string; p_campaign_id?: string | null; p_client_id?: string | null }
        Returns: {
          leads_discovered: number
          leads_verified: number
          cases_created: number
          emails_sent: number
          first_touch_sent: number
          followups_sent: number
          emails_bounced: number
          emails_failed: number
          replies_received: number
          leads_contacted: number
          leads_replied: number
          suppressions_added: number
          active_sequences: number
        }[]
      }
      analytics_daily: {
        Args: { p_from: string; p_to: string; p_campaign_id?: string | null; p_client_id?: string | null }
        Returns: {
          day: string
          leads_discovered: number
          emails_sent: number
          replies_received: number
        }[]
      }
      analytics_by_campaign: {
        Args: { p_from: string; p_to: string }
        Returns: {
          campaign_id: string
          campaign_name: string
          client_id: string
          campaign_status: Database['public']['Enums']['campaign_status']
          leads_discovered: number
          leads_verified: number
          cases_created: number
          emails_sent: number
          leads_contacted: number
          leads_replied: number
          cases_new: number
          cases_researching: number
          cases_ready: number
          cases_contacted: number
          cases_in_conversation: number
          cases_hot_handoff: number
          cases_won: number
          cases_lost: number
          cases_dead: number
        }[]
      }
      analytics_mailboxes: {
        Args: Record<string, never>
        Returns: {
          mailbox_id: string
          client_id: string
          email_address: string
          provider: Database['public']['Enums']['mailbox_provider']
          health: Database['public']['Enums']['mailbox_health']
          daily_cap: number
          sent_today: number
          sent_total: number
          bounced_total: number
          failed_total: number
          last_sent_at: string | null
        }[]
      }
      analytics_event_counts: {
        Args: { p_from: string; p_to: string; p_limit: number }
        Returns: { event_type: string; event_count: number }[]
      }
    }
    Enums: {
      user_role: 'operator' | 'client'
      log_severity: 'info' | 'warn' | 'error'
      log_source: 'app' | 'pipeline' | 'gemini' | 'apollo' | 'brightdata' | 'mailbox' | 'qstash' | 'db' | 'emailable'
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
      mailbox_provider: 'gmail' | 'outlook' | 'smtp'
      mailbox_health: 'ok' | 'warning' | 'blocked'
      warmup_profile: 'standard' | 'slow' | 'none'
      suppression_reason: 'replied' | 'bounced' | 'manual' | 'price_handoff'
      author_kind: 'agent' | 'human'
      knowledge_source_type: 'website_page' | 'pdf' | 'file'
      knowledge_source_status: 'pending' | 'ready' | 'failed'
    }
    CompositeTypes: Record<string, never>
  }
}

CREATE TABLE IF NOT EXISTS public.workflow_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    steps JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.workflow_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id BIGINT NOT NULL,
    project TEXT NOT NULL DEFAULT 'Mixario',
    user_query TEXT NOT NULL,
    template_id TEXT REFERENCES public.workflow_templates(id),
    status TEXT NOT NULL DEFAULT 'queued' 
        CHECK (status IN ('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
    current_step_index INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.workflow_run_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
    step_index INT NOT NULL,
    step_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model_alias TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' 
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
    inputs JSONB,
    output TEXT,
    error TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_lookup ON public.workflow_runs (chat_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_lookup ON public.workflow_run_steps (run_id, step_index);

INSERT INTO public.workflow_templates (id, name, description, steps)
VALUES (
    'tmpl_research_flow',
    'Research & Validation Flow',
    'Claude Web Search ➔ GPT Analysis ➔ Gemini Validation ➔ Approval Gate',
    '[
      {"id": "step_search", "provider": "anthropic", "model_alias": "claude-3-5-sonnet", "action": "web_research"},
      {"id": "step_analyze", "provider": "openai", "model_alias": "gpt-4o", "action": "analyze"},
      {"id": "step_validate", "provider": "google", "model_alias": "gemini-2.0-flash", "action": "validate"},
      {"id": "step_approval", "provider": "system", "model_alias": "human", "action": "approval_gate"}
    ]'::jsonb
) ON CONFLICT (id) DO UPDATE SET steps = EXCLUDED.steps;

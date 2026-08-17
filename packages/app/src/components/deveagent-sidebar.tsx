// DeveAgent Sidebar Panel — Experts, Skills, Memory, CodeGraph quick access
import { createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"

// Expert definitions
const EXPERTS = [
  { id: "chief", name: "Chief Agent", role: "Task decomposition & routing", icon: "robot" },
  { id: "planner", name: "Planner", role: "Architecture & API design", icon: "document" },
  { id: "codegraph", name: "CodeGraph", role: "Symbol search & dependencies", icon: "magnifying-glass" },
  { id: "reviewer", name: "Reviewer", role: "Regression & security review", icon: "shield" },
  { id: "security", name: "Security", role: "Vulnerability audit", icon: "lock" },
  { id: "test", name: "Test Agent", role: "Test strategy & coverage", icon: "beaker" },
  { id: "memory", name: "Memory Agent", role: "Past decisions & bug history", icon: "brain" },
  { id: "token", name: "Token Saver", role: "Context budget optimization", icon: "coin" },
  { id: "ui", name: "UI Agent", role: "Accessibility & consistency", icon: "eye" },
]

const SIDEBAR_LINKS = [
  { id: "skill-store", label: "Skill Store", desc: "Hermes/Claude/Codex/Tencent", icon: "sparkles" },
  { id: "codegraph", label: "CodeGraph", desc: "Symbol index & impact analysis", icon: "graph" },
  { id: "memory", label: "Memory Browser", desc: "Decisions, bugs, checkpoints", icon: "brain" },
]

export function DeveagentSidebar() {
  const [selectedExpert, setSelectedExpert] = createSignal<string | null>(null)
  const [expertsOpen, setExpertsOpen] = createSignal(false)

  return (
    <div class="flex flex-col gap-1 px-3 py-2 text-[13px]">
      {/* New Session Button */}
      <Button
        variant="primary"
        size="normal"
        class="w-full justify-start gap-2 mb-2"
        onClick={() => {
          // Trigger new session (handled by OpenCode's session system)
          window.dispatchEvent(new CustomEvent("deveagent:new-session"))
        }}
      >
        <Icon name="plus" size="small" />
        <span>New Session</span>
      </Button>

      {/* Experts Section */}
      <button
        class="flex items-center gap-2 w-full py-1.5 text-left text-[var(--text-weak)] hover:text-[var(--text-base)] transition-colors"
        onClick={() => setExpertsOpen(!expertsOpen())}
      >
        <Icon name={expertsOpen() ? "chevron-down" : "chevron-right"} size="small" />
        <Icon name="brain" size="small" />
        <span class="flex-1">Experts</span>
        <span class="text-[10px] text-\[var\(--text-weak\)\]">{EXPERTS.length}</span>
      </button>

      {expertsOpen() && (
        <div class="flex flex-col gap-0.5 ml-6">
          {EXPERTS.map((expert) => (
            <button
              class={`flex items-center gap-2 py-1 px-2 rounded text-left text-[12px] transition-colors ${
                selectedExpert() === expert.id
                  ? "bg-v2-background-bg-accent/10 text-v2-text-text-accent"
                  : "text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-base)]"
              }`}
              onClick={() => {
                setSelectedExpert(selectedExpert() === expert.id ? null : expert.id)
                window.dispatchEvent(new CustomEvent("deveagent:select-expert", { detail: expert }))
              }}
            >
              <Icon name={expert.icon as any} size="small" />
              <span class="flex-1 truncate">{expert.name}</span>
              <span class="text-[9px] px-1 rounded bg-\[var\(--surface-raised-base\)\] text-\[var\(--text-weak\)\]">RO</span>
            </button>
          ))}
        </div>
      )}

      {/* Divider */}
      <div class="h-px bg-[var(--border-base)] my-1" />

      {/* Quick Links */}
      {SIDEBAR_LINKS.map((link) => (
        <button
          class="flex items-center gap-2 w-full py-1.5 text-left text-[var(--text-weak)] hover:text-[var(--text-base)] transition-colors"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: link.id }))
          }}
        >
          <Icon name={link.icon as any} size="small" />
          <div class="flex flex-col min-w-0">
            <span class="text-[13px] truncate">{link.label}</span>
            <span class="text-[10px] text-\[var\(--text-weak\)\] truncate">{link.desc}</span>
          </div>
        </button>
      ))}
    </div>
  )
}

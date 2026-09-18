// DeveAgent Layout Sidebar — primary workbench navigation for the left panel
import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { markDeveagentStartup } from "@/deveagent-startup-timing"
import { Icon } from "@opencode-ai/ui/icon"
import { DEVEAGENT_WORK_PACKS, useDeveAgentComposerState } from "@/components/deveagent-composer-state"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export type DeveAgentSidebarSection = "workspace" | "capabilities"

export function deveAgentSidebarSectionId(section: DeveAgentSidebarSection) {
  return `deveagent-sidebar-${section}-group`
}

export function DeveagentLayoutSidebar(props: { workspaceContent?: JSX.Element }) {
  const [active, setActive] = createSignal("overview")
  const [workspaceOpen, setWorkspaceOpen] = createSignal(true)
  const [capabilitiesOpen, setCapabilitiesOpen] = createSignal(true)
  const [workPacksOpen, setWorkPacksOpen] = createSignal(false)
  const composer = useDeveAgentComposerState()
  const language = useLanguage()
  const selectedSkillCount = () => composer.snapshot().selectedSkills.length
  const teamMemberCount = () => composer.snapshot().expertTeam.length
  const openSkillStore = (tab: "market" | "mcp") => {
    setActive(tab === "mcp" ? "mcp" : "skills")
    window.dispatchEvent(new CustomEvent("deveagent:open-store", { detail: tab }))
  }

  const syncActiveFromPanelEvent = (event: Event) => {
    const detail = (event as CustomEvent).detail
    if (detail === "metrics" || detail === "token") return setActive("overview")
    if (detail === "review") return setActive("review")
    if (detail === "review-close" || detail === "close") return setActive("overview")
    if (detail === "experts") return setActive("experts")
    if (detail === "team") return setActive("team")
    if (detail === "codegraph") return setActive("codegraph")
    if (detail === "memory") return setActive("memory")
    if (detail === "skill-store") return setActive("skills")
  }

  onMount(() => {
    markDeveagentStartup("workbench-ready")
    const handleStore = (event: Event) => setActive((event as CustomEvent).detail === "mcp" ? "mcp" : "skills")
    const handleDashboardTab = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (detail === "overview") setActive("overview")
      if (detail === "codegraph") setActive("codegraph")
    }
    const handlePanelState = (event: Event) => {
      const detail = (event as CustomEvent).detail as { reviewOpen?: boolean } | undefined
      if (detail?.reviewOpen === false && active() === "review") setActive("overview")
      if (detail?.reviewOpen === true) setActive("review")
    }
    window.addEventListener("deveagent:open-panel", syncActiveFromPanelEvent)
    window.addEventListener("deveagent:open-store", handleStore)
    window.addEventListener("deveagent:dashboard-tab", handleDashboardTab)
    window.addEventListener("deveagent:panel-state", handlePanelState)
    onCleanup(() => {
      window.removeEventListener("deveagent:open-panel", syncActiveFromPanelEvent)
      window.removeEventListener("deveagent:open-store", handleStore)
      window.removeEventListener("deveagent:dashboard-tab", handleDashboardTab)
      window.removeEventListener("deveagent:panel-state", handlePanelState)
    })
  })

  const itemClass = (id: string) =>
    `flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
      active() === id
        ? "bg-v2-background-bg-accent/10 text-v2-text-text-accent"
        : "text-text-base hover:bg-v2-background-bg-layer-01 hover:text-text-strong"
    }`

  return (
    <div
      class="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-1 px-2 py-2 text-[13px]"
      data-component="deveagent-workbench-nav"
    >
      <div class="flex min-w-0 flex-none flex-col">
        <button
          type="button"
          data-action="deveagent-sidebar-toggle-workspace"
          class="flex h-7 w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-1.5 text-left text-[10px] font-medium uppercase tracking-wide text-v2-text-text-faint hover:bg-surface-base-hover hover:text-text-weak"
          aria-expanded={workspaceOpen()}
          aria-controls={deveAgentSidebarSectionId("workspace")}
          onClick={() => setWorkspaceOpen((open) => !open)}
        >
          <Icon
            name="chevron-down"
            size="small"
            class={workspaceOpen() ? "shrink-0 transition-transform" : "shrink-0 rotate-[-90deg] transition-transform"}
          />
          <span class="min-w-0 flex-1 truncate">{language.t("deveagent.sidebar.workspace")}</span>
        </button>
        <Show when={workspaceOpen()}>
          <div
            id={deveAgentSidebarSectionId("workspace")}
            class="pr-0.5"
            data-component="deveagent-sidebar-workspace-group"
            role="group"
          >
            <button
              class="flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-v2-border-border-muted bg-surface-base-hover px-2 py-1.5 text-left text-[13px] font-medium text-text-strong transition-colors hover:bg-surface-base-active"
              onClick={() => {
                setActive("workspace")
                window.dispatchEvent(new CustomEvent("deveagent:new-session"))
              }}
            >
              <Icon name="plus" size="small" class="shrink-0 text-v2-text-text-accent" />
              <span class="min-w-0 flex-1 truncate">{language.t("deveagent.sidebar.newSession")}</span>
            </button>

            <button
              class={itemClass("overview")}
              data-action="deveagent-open-overview"
              title={language.t("deveagent.shell.openOverview")}
              onClick={() => {
                setActive("overview")
                window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "metrics" }))
              }}
            >
              <Icon name="eye" size="small" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate font-medium">{language.t("deveagent.sidebar.overview")}</span>
            </button>
            <button
              class={itemClass("review")}
              data-action="deveagent-open-review"
              title={language.t("deveagent.shell.openReview")}
              onClick={() => {
                setActive("review")
                window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "review" }))
              }}
            >
              <Icon name="review" size="small" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate font-medium">{language.t("deveagent.sidebar.review")}</span>
            </button>

            <button
              class={itemClass("work-packs")}
              title={language.t("deveagent.shell.workPacksHelp")}
              data-action="deveagent-work-packs"
              aria-expanded={workPacksOpen()}
              aria-controls="deveagent-work-packs-menu"
              onClick={() => {
                setActive("work-packs")
                setWorkPacksOpen((open) => !open)
              }}
            >
              <Icon name="bullet-list" size="small" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate font-medium">{language.t("deveagent.sidebar.workPacks")}</span>
              <span class="shrink-0 text-[10px] text-v2-text-text-faint">
                {workPacksOpen() ? language.t("deveagent.sidebar.collapse") : language.t("deveagent.sidebar.select")}
              </span>
            </button>
            <Show when={workPacksOpen()}>
              <div id="deveagent-work-packs-menu" class="rounded-md border border-v2-border-border-muted bg-surface-raised-base p-1">
                <For each={DEVEAGENT_WORK_PACKS}>
                  {(pack) => {
                    const selected = () => {
                      const snapshot = composer.snapshot()
                      const skills = new Set(snapshot.selectedSkills.map((skill) => skill.id))
                      return snapshot.mode === pack.mode && pack.skillIDs.every((id) => skills.has(id))
                    }
                    return (
                      <button
                        type="button"
                        data-action={`deveagent-work-pack-${pack.id}`}
                        class={`w-full min-w-0 rounded px-2 py-1.5 text-left transition-colors ${
                          selected() ? "bg-v2-background-bg-accent/10 text-v2-text-text-accent" : "text-text-base hover:bg-v2-background-bg-layer-01"
                        }`}
                        onClick={() => {
                          composer.applyWorkPack(pack.id)
                          showToast({
                            title: language.t("deveagent.layout.appliedPack", { name: pack.name }),
                            description: [
                              language.t("deveagent.layout.appliedPackDefault"),
                              pack.role
                                ? language.t("deveagent.layout.appliedPackRole", { role: pack.role })
                                : undefined,
                            ]
                              .filter(Boolean)
                              .join(" "),
                          })
                        }}
                      >
                        <span class="block truncate text-[12px] font-medium">{pack.name}</span>
                        <span class="mt-0.5 block text-[10px] leading-4 text-text-weak">
                          {/* Work Pack descriptions are content data carried by
                              DEVEAGENT_WORK_PACKS, not UI labels, so they keep
                              their own bilingual pair rather than a dictionary key. */}
                          {language.locale() === "zh" || language.locale() === "zht" ? pack.description : pack.descriptionEn ?? pack.description}
                        </span>
                        <Show when={pack.role}>
                          <span class="mt-1 inline-block rounded bg-v2-background-bg-accent/10 px-1.5 py-0.5 text-[9px] font-medium text-v2-text-text-accent">
                            {language.t("deveagent.layout.role")}: {pack.role}
                          </span>
                        </Show>
                      </button>
                    )
                  }}
                </For>
              </div>
            </Show>
            <Show when={props.workspaceContent}>
              <div
                class="mt-2 border-t border-v2-border-border-muted pt-2"
                data-component="deveagent-sidebar-workspace-projects"
              >
                {props.workspaceContent}
              </div>
            </Show>
          </div>
        </Show>
      </div>

      <div class="mt-2 flex shrink-0 flex-col border-t border-v2-border-border-muted pt-2">
        <button
          type="button"
          data-action="deveagent-sidebar-toggle-capabilities"
          class="flex h-7 w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-1.5 text-left text-[10px] font-medium uppercase tracking-wide text-v2-text-text-faint hover:bg-surface-base-hover hover:text-text-weak"
          aria-expanded={capabilitiesOpen()}
          aria-controls={deveAgentSidebarSectionId("capabilities")}
          onClick={() => setCapabilitiesOpen((open) => !open)}
        >
          <Icon
            name="chevron-down"
            size="small"
            class={
              capabilitiesOpen() ? "shrink-0 transition-transform" : "shrink-0 rotate-[-90deg] transition-transform"
            }
          />
          <span class="min-w-0 flex-1 truncate">{language.t("deveagent.sidebar.capabilities")}</span>
        </button>

        <Show when={capabilitiesOpen()}>
          <div
            id={deveAgentSidebarSectionId("capabilities")}
            class="pr-0.5"
            data-component="deveagent-sidebar-capabilities-group"
            role="group"
          >
            <button
              class={itemClass("experts")}
              onClick={() => {
                setActive("experts")
                window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "experts" }))
              }}
            >
              <Icon name="brain" size="small" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate font-medium">{language.t("deveagent.sidebar.experts")}</span>
            </button>

            <button
              class={itemClass("skills")}
              title={language.t("deveagent.shell.skillStoreHelp")}
              onClick={() => openSkillStore("market")}
            >
              <Icon name="models" size="small" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate font-medium">{language.t("deveagent.sidebar.skillStore")}</span>
              {selectedSkillCount() > 0 && (
                <span
                  class="shrink-0 rounded-full bg-v2-background-bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-v2-text-text-accent"
                  title="Current session selected Skill count"
                >
                  {selectedSkillCount()}
                </span>
              )}
            </button>
            <button
              class={itemClass("mcp")}
              title={language.t("deveagent.shell.mcpMarketHelp")}
              onClick={() => openSkillStore("mcp")}
            >
              <Icon name="mcp" size="small" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate font-medium">{language.t("deveagent.sidebar.mcpMarket")}</span>
            </button>
            <button
              class={itemClass("codegraph")}
              data-action="deveagent-open-codegraph"
              title={language.t("deveagent.shell.codeGraphHelp")}
              onClick={() => {
                setActive("codegraph")
                window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "codegraph" }))
              }}
            >
              <Icon name="magnifying-glass" size="small" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate font-medium">{language.t("deveagent.sidebar.codeGraph")}</span>
            </button>
            <button
              class={itemClass("memory")}
              onClick={() => {
                setActive("memory")
                window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "memory" }))
              }}
            >
              <Icon name="brain" size="small" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate font-medium">{language.t("deveagent.sidebar.memory")}</span>
            </button>
            <button
              class={`${itemClass("team")} mt-1 font-medium`}
              title={language.t("deveagent.shell.teamHelp")}
              onClick={() => {
                setActive("team")
                window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "team" }))
              }}
            >
              <Icon name="brain" size="small" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate">{language.t("deveagent.sidebar.team")}</span>
              {teamMemberCount() > 0 && (
                <span
                  class="shrink-0 rounded-full bg-v2-background-bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-v2-text-text-accent"
                  title="Current configured team member count"
                >
                  {teamMemberCount()}
                </span>
              )}
            </button>
            <button
              class={`${itemClass("worktrees")} mt-1 font-medium`}
              title={language.t("deveagent.layout.worktreesHint")}
              onClick={() => {
                setActive("worktrees")
                window.dispatchEvent(new CustomEvent("deveagent:open-panel", { detail: "worktrees" }))
              }}
              data-action="deveagent-sidebar-worktrees"
            >
              <Icon name="folder" size="small" class="shrink-0" />
              <span class="min-w-0 flex-1 truncate">{language.t("deveagent.layout.worktrees")}</span>
            </button>
          </div>
        </Show>
      </div>
    </div>
  )
}

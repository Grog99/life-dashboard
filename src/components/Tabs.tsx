import { useRef, type KeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";

export interface TabItem {
  id: string;
  label: string;
  icon?: LucideIcon;
}

export interface TabsProps {
  tabs: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  idBase: string;
  ariaLabel: string;
}

export function Tabs({ tabs, activeId, onChange, idBase, ariaLabel }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const focusTabAt = (index: number) => {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = tabs.length;
    if (count === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % count;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + count) % count;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = count - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    focusTabAt(nextIndex);
    onChange(nextTab.id);
  };

  return (
    <div ref={listRef} role="tablist" aria-label={ariaLabel} className="settings-tabs">
      {tabs.map((tab, index) => {
        const active = tab.id === activeId;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${idBase}-tab-${tab.id}`}
            aria-selected={active}
            aria-controls={`${idBase}-panel-${tab.id}`}
            tabIndex={active ? 0 : -1}
            className={active ? "settings-tab active" : "settings-tab"}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {Icon && <Icon size={16} />}
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

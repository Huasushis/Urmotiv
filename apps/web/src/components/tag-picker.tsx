import type { ProblemTag } from "@urmotiv/contracts";
import { Check, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

type TagPickerProps = {
  tags: ProblemTag[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
};

type TagGroup = {
  name: string;
  tags: ProblemTag[];
};

const MAX_SELECTED_TAGS = 30;

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

export function TagPicker({ tags, value, onChange, disabled = false }: TagPickerProps) {
  const helpId = useId();
  const [search, setSearch] = useState("");

  const uniqueTags = useMemo(() => {
    const byId = new Map<string, ProblemTag>();
    for (const tag of tags) {
      if (!byId.has(tag.id)) {
        byId.set(tag.id, tag);
      }
    }
    return [...byId.values()];
  }, [tags]);

  const groups = useMemo(() => {
    const byName = new Map<string, ProblemTag[]>();
    for (const tag of uniqueTags) {
      const groupTags = byName.get(tag.group);
      if (groupTags === undefined) {
        byName.set(tag.group, [tag]);
      } else {
        groupTags.push(tag);
      }
    }
    return [...byName].map(([name, groupTags]): TagGroup => ({ name, tags: groupTags }));
  }, [uniqueTags]);

  const tagById = useMemo(
    () => new Map(uniqueTags.map((tag) => [tag.id, tag] as const)),
    [uniqueTags],
  );
  const selectedIds = uniqueIds(value);
  const selectedIdSet = new Set(selectedIds);
  const limitReached = selectedIds.length >= MAX_SELECTED_TAGS;
  const normalizedSearch = normalizeSearchText(search);
  const selectedGroups = groups
    .filter((group) => group.tags.some((tag) => selectedIdSet.has(tag.id)))
    .map((group) => group.name);
  const selectedAutoOpenKey = JSON.stringify([selectedIds, selectedGroups]);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(selectedGroups));

  const visibleGroups = useMemo(
    () =>
      groups.flatMap((group) => {
        if (normalizedSearch.length === 0) {
          return [group];
        }
        if (normalizeSearchText(group.name).includes(normalizedSearch)) {
          return [group];
        }
        const matchingTags = group.tags.filter((tag) =>
          normalizeSearchText(tag.name).includes(normalizedSearch),
        );
        return matchingTags.length === 0 ? [] : [{ ...group, tags: matchingTags }];
      }),
    [groups, normalizedSearch],
  );

  useEffect(() => {
    if (selectedGroups.length === 0) {
      return;
    }
    setOpenGroups((current) => {
      if (selectedGroups.every((group) => current.has(group))) {
        return current;
      }
      return new Set([...current, ...selectedGroups]);
    });
    // The serialized key ignores equivalent array instances while still reopening selected
    // groups when the controlled value or asynchronously loaded catalogue really changes.
  }, [selectedAutoOpenKey]);

  const setSelected = (id: string, selected: boolean) => {
    if (disabled) {
      return;
    }
    const current = uniqueIds(value);
    if (!selected) {
      onChange(current.filter((item) => item !== id));
      return;
    }
    if (current.length < MAX_SELECTED_TAGS && !current.includes(id)) {
      onChange([...current, id]);
    }
  };

  return (
    <fieldset
      className="tag-picker"
      aria-label="知识点"
      aria-disabled={disabled || undefined}
      disabled={disabled}
    >
      <div className="tag-picker-selected">
        <div className="tag-picker-selected-heading">
          <strong>已选知识点</strong>
          <span>
            {selectedIds.length} / {MAX_SELECTED_TAGS}
          </span>
        </div>
        {selectedIds.length === 0 ? (
          <p>尚未选择知识点</p>
        ) : (
          <div className="tag-picker-selected-list">
            {selectedIds.map((id) => {
              const name = tagById.get(id)?.name ?? `未知标签（${id}）`;
              return (
                <button
                  key={id}
                  type="button"
                  className="tag-selected-item"
                  onClick={() => setSelected(id, false)}
                  disabled={disabled}
                  aria-label={`移除知识点“${name}”`}
                  title={`移除“${name}”`}
                >
                  <span>{name}</span>
                  <X size={13} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
      </div>

      <label className="tag-picker-search">
        <span>搜索知识点或分类</span>
        <span className="tag-picker-search-control">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="输入知识点或分类名称"
          />
        </span>
      </label>

      <p
        id={helpId}
        className={limitReached ? "tag-picker-help limit-reached" : "tag-picker-help"}
        aria-live="polite"
      >
        {limitReached
          ? `已达到 ${MAX_SELECTED_TAGS} 项上限，请先移除一个知识点再选择。`
          : `每道题最多选择 ${MAX_SELECTED_TAGS} 个知识点。`}
      </p>

      <div className="tag-picker-groups">
        {visibleGroups.map((group) => {
          const searchForcesOpen = normalizedSearch.length > 0;
          const selectedInGroup = group.tags.filter((tag) => selectedIdSet.has(tag.id)).length;
          return (
            <details
              key={group.name}
              className="tag-picker-group"
              open={searchForcesOpen || openGroups.has(group.name)}
              onToggle={(event) => {
                if (searchForcesOpen) {
                  if (!event.currentTarget.open) {
                    event.currentTarget.open = true;
                  }
                  return;
                }
                const open = event.currentTarget.open;
                setOpenGroups((current) => {
                  if (current.has(group.name) === open) {
                    return current;
                  }
                  const next = new Set(current);
                  if (open) {
                    next.add(group.name);
                  } else {
                    next.delete(group.name);
                  }
                  return next;
                });
              }}
            >
              <summary>
                <span>{group.name}</span>
                <small>
                  已选 {selectedInGroup}，共 {group.tags.length}
                </small>
              </summary>
              <div className="tag-picker-options">
                {group.tags.map((tag) => {
                  const selected = selectedIdSet.has(tag.id);
                  const unavailable = disabled || (limitReached && !selected);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      className={selected ? "tag-choice selected" : "tag-choice"}
                      onClick={() => setSelected(tag.id, !selected)}
                      disabled={unavailable}
                      aria-pressed={selected}
                      aria-describedby={helpId}
                      title={limitReached && !selected ? "已达到知识点数量上限" : undefined}
                    >
                      {selected ? <Check size={14} aria-hidden="true" /> : null}
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </details>
          );
        })}
        {visibleGroups.length === 0 ? (
          <p className="tag-picker-empty">没有匹配的知识点或分类。</p>
        ) : null}
      </div>
    </fieldset>
  );
}

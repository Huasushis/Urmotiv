import { Check } from "lucide-react";
import type { ProblemTag } from "@urmotiv/contracts";

type TagPickerProps = {
  tags: ProblemTag[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
};

export function TagPicker({ tags, value, onChange, disabled = false }: TagPickerProps) {
  const toggle = (id: string) => {
    if (disabled) {
      return;
    }
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  };

  return (
    <div className="tag-picker" aria-label="知识点">
      {tags.map((tag) => {
        const selected = value.includes(tag.id);
        return (
          <button
            key={tag.id}
            type="button"
            className={selected ? "tag-choice selected" : "tag-choice"}
            onClick={() => toggle(tag.id)}
            disabled={disabled}
            aria-pressed={selected}
          >
            {selected ? <Check size={14} aria-hidden="true" /> : null}
            {tag.name}
          </button>
        );
      })}
    </div>
  );
}

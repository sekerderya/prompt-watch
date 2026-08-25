"use client";

/**
 * Word-level diff between two prompt versions.
 *
 * Versioning a prompt is only useful if you can see what changed, and "what
 * changed" for a prompt is almost always a phrase, not a line — so this
 * tokenises on whitespace rather than newlines. Implemented here rather than
 * pulled in: a longest-common-subsequence over a few hundred words is a small,
 * well-understood problem, and prompts are short enough that the O(n*m) table
 * is measured in kilobytes.
 */

type Op = { kind: "same" | "added" | "removed"; text: string };

/** Splits into words while keeping the whitespace, so output is reconstructable. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

function diffTokens(before: string[], after: string[]): Op[] {
  const rows = before.length;
  const cols = after.length;

  // lcs[i][j] = length of the longest common subsequence of before[i:], after[j:]
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i][j] =
        before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  const push = (kind: Op["kind"], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.kind === kind) last.text += text;
    else ops.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      push("same", before[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push("removed", before[i]);
      i++;
    } else {
      push("added", after[j]);
      j++;
    }
  }
  while (i < rows) push("removed", before[i++]);
  while (j < cols) push("added", after[j++]);

  return ops;
}

export default function PromptDiff({ before, after }: { before: string; after: string }) {
  if (before === after) {
    return <p className="pw-subtle">These two versions have identical text.</p>;
  }

  const ops = diffTokens(tokenize(before), tokenize(after));

  return (
    <pre className="pw-diff" aria-label="Prompt text difference">
      {ops.map((op, index) => {
        if (op.kind === "same") return <span key={index}>{op.text}</span>;
        return (
          <span key={index} className={`pw-diff__${op.kind}`}>
            {op.text}
          </span>
        );
      })}
    </pre>
  );
}

import { memo, useEffect, useMemo, useState } from 'react'
import type { FileEntry } from '@shared/types'

export interface TreeNode {
  name: string
  /** Absolute folder path. */
  path: string
  /** Images directly in this folder. */
  direct: number
  /** Images in this folder and all subfolders. */
  total: number
  children: TreeNode[]
  /** Top-level folder that couldn't be read (unmounted drive, deleted…). */
  missing?: boolean
}

/** '' stands for "all opened folders". */
export const ALL = ''

const lastSep = (p: string) => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
export const baseName = (p: string) => p.replace(/[\\/]+$/, '').slice(lastSep(p.replace(/[\\/]+$/, '')) + 1) || p
/** Absolute directory of a file. */
export const dirOfFile = (f: FileEntry) => f.path.slice(0, f.path.length - f.name.length - 1)
const parentDir = (p: string) => p.slice(0, Math.max(0, lastSep(p)))

/** True if `dir` is `sel` or lies below it. */
export function isUnder(dir: string, sel: string) {
  if (dir === sel) return true
  return dir.startsWith(sel) && (dir[sel.length] === '/' || dir[sel.length] === '\\' || /[\\/]$/.test(sel))
}

/** One tree per opened folder, containing every directory that holds images (directly or below). */
export function buildTrees(
  files: FileEntry[],
  roots: string[],
  missing: string[],
  /** Which files the counts include (search / favorites); the folder structure always uses all files. */
  counted: (f: FileEntry) => boolean = () => true
): TreeNode[] {
  const byPath = new Map<string, TreeNode>()
  const trees: TreeNode[] = roots.map((r) => {
    const node: TreeNode = { name: baseName(r), path: r, direct: 0, total: 0, children: [], missing: missing.includes(r) }
    byPath.set(r, node)
    return node
  })
  const ensure = (path: string, root: string): TreeNode => {
    let node = byPath.get(path)
    if (node) return node
    // Paths at or above the root (e.g. root "C:\\" vs dir "C:") belong to the root itself.
    if (path.length <= root.length) return byPath.get(root)!
    const parent = ensure(parentDir(path), root)
    node = { name: path.slice(lastSep(path) + 1), path, direct: 0, total: 0, children: [] }
    parent.children.push(node)
    byPath.set(path, node)
    return node
  }
  for (const f of files) {
    if (!byPath.has(f.root)) continue
    const dir = dirOfFile(f)
    const node = ensure(dir, f.root)
    if (!counted(f)) continue
    node.direct++
    for (let d = dir; ; d = parentDir(d)) {
      if (d.length <= f.root.length) {
        byPath.get(f.root)!.total++
        break
      }
      byPath.get(d)!.total++
    }
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    n.children.forEach(sort)
  }
  trees.forEach(sort)
  return trees
}

interface Props {
  trees: TreeNode[]
  selected: string
  includeSub: boolean
  onSelect: (path: string) => void
  onRemoveRoot: (path: string) => void
}

export default function FolderTree({ trees, selected, includeSub, onSelect, onRemoveRoot }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(trees.map((t) => t.path)))

  // Newly added roots start expanded; the selected folder's ancestors are always expanded.
  const rootKey = trees.map((t) => t.path).join('\n')
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const t of trees) next.add(t.path)
      const root = trees.find((t) => isUnder(selected, t.path))
      if (root && selected !== ALL) {
        for (let d = parentDir(selected); d.length >= root.path.length; d = parentDir(d)) {
          next.add(d)
          if (d === root.path || !d) break
        }
      }
      return next.size === prev.size ? prev : next
    })
  }, [selected, rootKey])

  const toggle = useMemo(
    () => (path: string) =>
      setExpanded((prev) => {
        const next = new Set(prev)
        next.has(path) ? next.delete(path) : next.add(path)
        return next
      }),
    []
  )

  const total = trees.reduce((n, t) => n + t.total, 0)
  return (
    <nav className="tree" aria-label="Folders">
      {trees.length > 1 && (
        <div
          className={`tree-row all${selected === ALL ? ' active' : ''}`}
          style={{ paddingLeft: 6 }}
          onClick={() => onSelect(ALL)}
        >
          <span className="tree-chevron none">›</span>
          <svg className="tree-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M1.5 5.5h4.2l1.5 1.5h7.3v6h-13z M3 3h4l1 1h6" />
          </svg>
          <span className="tree-name">All folders</span>
          <span className="tree-count">{total}</span>
        </div>
      )}
      {trees.map((t) => (
        <Row
          key={t.path}
          node={t}
          depth={0}
          isRoot
          selected={selected}
          expanded={expanded}
          includeSub={includeSub}
          onSelect={onSelect}
          onToggle={toggle}
          onRemove={onRemoveRoot}
        />
      ))}
    </nav>
  )
}

interface RowProps {
  node: TreeNode
  depth: number
  isRoot?: boolean
  selected: string
  expanded: Set<string>
  includeSub: boolean
  onSelect: (path: string) => void
  onToggle: (path: string) => void
  onRemove: (path: string) => void
}

const Row = memo(function Row({ node, depth, isRoot, selected, expanded, includeSub, onSelect, onToggle, onRemove }: RowProps) {
  const open = expanded.has(node.path)
  const hasKids = node.children.length > 0
  const count = includeSub ? node.total : node.direct
  return (
    <>
      <div
        className={`tree-row${isRoot ? ' root' : ''}${node.path === selected ? ' active' : ''}${count === 0 ? ' dim' : ''}${node.missing ? ' missing' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => onSelect(node.path)}
        onDoubleClick={() => hasKids && onToggle(node.path)}
        title={node.missing ? `${node.path}\nNot available right now` : node.path}
      >
        <span
          className={`tree-chevron${hasKids ? '' : ' none'}${open ? ' open' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            if (hasKids) onToggle(node.path)
          }}
        >
          ›
        </span>
        <svg className="tree-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M1.5 3.5h4.2l1.5 1.5h7.3v7.5h-13z" />
        </svg>
        <span className="tree-name">{node.name}</span>
        {node.missing ? <span className="tree-count">unavailable</span> : <span className="tree-count">{count}</span>}
        {isRoot && (
          <button
            className="tree-remove"
            title="Remove this folder from the viewer (files stay on disk)"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(node.path)
            }}
          >
            ×
          </button>
        )}
      </div>
      {open &&
        node.children.map((c) => (
          <Row
            key={c.path}
            node={c}
            depth={depth + 1}
            selected={selected}
            expanded={expanded}
            includeSub={includeSub}
            onSelect={onSelect}
            onToggle={onToggle}
            onRemove={onRemove}
          />
        ))}
    </>
  )
})

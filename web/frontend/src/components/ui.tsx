import * as React from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "secondary" | "ghost" | "destructive"
}

export function Button({ className, variant = "default", ...props }: ButtonProps) {
  const meaningfulChildren = React.Children.toArray(props.children).filter(
    (child) => typeof child !== "string" || child.trim().length > 0,
  )
  const iconOnly = meaningfulChildren.length === 1 && React.isValidElement(meaningfulChildren[0])
  return <button className={cn("btn", `btn-${variant}`, iconOnly && "btn-icon", className)} {...props} />
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn("field", props.className)} />
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn("field textarea", props.className)} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn("field", props.className)} />
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <section className={cn("card", className)} {...props} />
}

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("badge", className)} {...props} />
}

export function Tabs({
  value,
  onChange,
  items,
}: {
  value: string
  onChange: (value: string) => void
  items: { value: string; label: string; icon?: React.ReactNode }[]
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          className={cn("tab", value === item.value && "tab-active")}
          key={item.value}
          onClick={() => onChange(item.value)}
          role="tab"
          aria-selected={value === item.value}
          title={item.label}
          type="button"
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function Dialog({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean
  title: string
  children: React.ReactNode
  onClose: () => void
}) {
  if (!open) return null
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <Button variant="ghost" onClick={onClose} type="button" aria-label="Close dialog" title="Close">
            <X size={16} />
          </Button>
        </div>
        {children}
      </div>
    </div>
  )
}

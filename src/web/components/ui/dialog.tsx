import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

/** 確認ダイアログ（shadcn/ui の Dialog を簡略化したもの）。 */
export const Dialog = ({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) => (
  <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <DialogPrimitive.Content
        className={cn(
          // 画面より高くなったら（環境の設定など）、中身をスクロールして操作ボタンまで届くようにする
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border bg-background p-6 shadow-lg",
          className,
        )}
      >
        <DialogPrimitive.Title className="font-semibold text-lg">
          {title}
        </DialogPrimitive.Title>
        {description !== undefined && (
          <DialogPrimitive.Description className="text-muted-foreground text-sm">
            {description}
          </DialogPrimitive.Description>
        )}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>
);

export const DialogFooter = ({
  className,
  ...props
}: ComponentProps<"div">) => (
  <div className={cn("flex justify-end gap-2", className)} {...props} />
);

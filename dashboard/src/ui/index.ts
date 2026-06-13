// The design-system barrel — feature agents import primitives from here:
//   import { Button, Badge, DeliveryBadge, Sheet, useToast } from '../ui';
// This file (and everything under src/ui/) is SHARED — feature agents import
// from it and MUST NOT edit it.
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button.js';
export { IconButton, type IconButtonProps } from './IconButton.js';
export { Badge, type BadgeProps, type BadgeTone } from './Badge.js';
export { DeliveryBadge, type DeliveryBadgeProps } from './DeliveryBadge.js';
export {
  presentDeliveryStatus,
  deliveryReason,
  type DeliveryPresentation,
} from './deliveryStatus.js';
export { Spinner, type SpinnerProps } from './Spinner.js';
export { EmptyState, type EmptyStateProps } from './EmptyState.js';
export { Avatar, type AvatarProps } from './Avatar.js';
export { initialsFrom } from './initials.js';
export { Field, Input, Textarea, type FieldProps, type InputProps, type TextareaProps } from './Field.js';
export { Sheet, type SheetProps } from './Sheet.js';
export {
  ToastProvider,
  useToast,
  type ToastApi,
  type ToastTone,
} from './Toast.js';
export * from './icons.js';

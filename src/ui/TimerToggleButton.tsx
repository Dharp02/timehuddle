/**
 * TimerToggleButton — Shared start/stop timer button.
 *
 * Reused across WorkPage, TicketsPage and the Redmine search suggestions for
 * consistent timer controls.
 */
import { faPause, faPlay } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Button, Tooltip } from '@mieweb/ui';
import React from 'react';

export interface TimerToggleButtonProps {
  isRunning: boolean;
  isLoading?: boolean;
  disabled?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  ariaLabel?: string;
  title?: string;
  /** Extra classes, e.g. a smaller size inside a dense row. */
  className?: string;
  /**
   * For a button inside a combobox option, which cannot hold focusable
   * controls: take it out of the tab order and hide it from assistive tech
   * (the keyboard gets a shortcut instead), and keep focus in the input.
   */
  tabIndex?: number;
  'aria-hidden'?: boolean;
  onMouseDown?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

export const TimerToggleButton: React.FC<TimerToggleButtonProps> = ({
  isRunning,
  isLoading = false,
  disabled = false,
  onClick,
  ariaLabel,
  title,
  className = '',
  tabIndex,
  'aria-hidden': ariaHidden,
  onMouseDown,
}) => {
  const buttonContent = (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      onMouseDown={onMouseDown}
      tabIndex={tabIndex}
      aria-hidden={ariaHidden}
      disabled={disabled || isLoading}
      // `Button` wraps its content in an inline label span, which sits the icon
      // on the text baseline; a flex label centres it.
      className={`rounded-full [&_[data-slot=button-label]]:flex ${
        isRunning
          ? 'bg-amber-100 text-amber-600 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-400'
          : 'bg-green-100 text-green-600 hover:bg-green-200 dark:bg-green-900/40 dark:text-green-400'
      } ${className}`}
      aria-label={ariaLabel ?? (isRunning ? 'Stop timer' : 'Start timer')}
      style={disabled && !isLoading ? { pointerEvents: 'none' } : undefined}
    >
      <FontAwesomeIcon icon={isRunning ? faPause : faPlay} className="text-xs" />
    </Button>
  );

  if (!title) return buttonContent;

  // A disabled button gets no pointer events, so the tooltip hangs off a span.
  return (
    <Tooltip content={title}>
      {disabled ? (
        <span className="inline-flex" style={{ cursor: 'not-allowed' }}>
          {buttonContent}
        </span>
      ) : (
        buttonContent
      )}
    </Tooltip>
  );
};

const base =
  'inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md text-[12px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40'

export const btn = `${base} h-7 border border-ui-300 bg-ui-0 px-2.5 text-ui-700 shadow-xs hover:border-ui-400 hover:bg-ui-50 active:bg-ui-100 disabled:hover:border-ui-300 disabled:hover:bg-ui-0`

export const btnPrimary = `${base} h-7 border border-blue-600 bg-blue-600 px-3 font-medium text-white shadow-xs hover:border-blue-700 hover:bg-blue-700 active:bg-blue-800 disabled:hover:border-blue-600 disabled:hover:bg-blue-600`

export const btnSoft = `${base} h-7 border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/10 px-2.5 font-medium text-blue-700 dark:text-blue-300 hover:border-blue-300 dark:hover:border-blue-500/45 hover:bg-blue-100 dark:hover:bg-blue-500/20 active:bg-blue-200/70 dark:active:bg-blue-500/25 disabled:hover:border-blue-200 dark:disabled:hover:border-blue-500/30 disabled:hover:bg-blue-50 dark:disabled:hover:bg-blue-500/10`

export const btnDanger = `${base} h-7 border border-red-200 dark:border-red-500/30 bg-ui-0 px-3 text-red-600 dark:text-red-400 shadow-xs hover:border-red-300 dark:hover:border-red-500/45 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:hover:border-red-200 dark:disabled:hover:border-red-500/30 disabled:hover:bg-ui-0`

export const iconBtn = `${base} h-7 w-7 shrink-0 text-ui-500 hover:bg-ui-100 hover:text-ui-800 active:bg-ui-200 disabled:hover:bg-transparent disabled:hover:text-ui-500`

export const iconBtnSm = `${base} h-6 w-6 shrink-0 text-ui-400 hover:bg-ui-100 active:bg-ui-200 disabled:hover:bg-transparent`

export const input =
  'h-7 rounded-md border border-ui-300 bg-ui-0 px-2 text-[12px] text-ui-800 outline-none transition-[border-color,box-shadow] placeholder:text-ui-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:bg-ui-50 disabled:text-ui-400'

export const dialogInput =
  'w-full rounded-md border border-ui-300 bg-ui-0 px-2.5 py-1.5 text-ui-800 outline-none transition-[border-color,box-shadow] placeholder:text-ui-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:bg-ui-50 disabled:text-ui-400'

export const optionCard =
  'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 transition-colors'

export const optionCardState = (checked: boolean): string =>
  checked
    ? 'border-blue-400 dark:border-blue-500/60 bg-blue-50/70 dark:bg-blue-500/10 text-ui-900'
    : 'border-ui-200 text-ui-700 hover:border-ui-300 hover:bg-ui-50'

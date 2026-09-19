/**
 * Provider Copy — desktop half.
 *
 * Copy the provider keys set on one profile onto other profiles: a one-time,
 * explicit copy — never a live sync. The heavy lifting lives in
 * `dashboard/plugin_api.py`; this half is the picker UI and talks to it through
 * `ctx.rest` (the plugin's own `/api/plugins/provider-copy/` namespace). That
 * door is profile-aware, so every request carries the app's active profile and
 * the backend can default `Copy keys from` to the profile you're on.
 *
 * Surface: a full page (sidebar row + route) and a ⌘K palette row. The plugin
 * SDK has no settings-page injection point, so this page is the plugin's own
 * surface — one click from the sidebar, or ⌘K → "Provider Copy".
 */

import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
  haptic,
  host,
  useMutation,
  usePluginI18n,
  useQuery,
  useQueryClient
} from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'provider-copy'
const NAV_PATH = '/provider-copy'

const STRINGS = {
  en: {
    nav: 'Provider Copy',
    openCommand: 'Provider Copy: copy keys to other profiles',
    title: 'Provider Copy',
    subtitle:
      'Copy the provider keys set on one profile onto your other bots — a one-time copy, nothing stays linked afterwards.',
    sourceLabel: 'Copy keys from:',
    keysReadyOne: '1 provider key ready',
    keysReady: n => `${n} provider keys ready`,
    noKeys: 'No provider keys are set on this profile yet',
    noKeysHint: 'Add one on the Providers page first, then come back.',
    neverCopied:
      'OAuth sign-ins and messaging bot tokens are never copied — only provider API keys and provider base URLs.',
    targetsLabel: 'Copy to',
    missingOne: '1 key missing',
    missing: n => `${n} keys missing`,
    upToDate: 'up to date',
    unreadable: 'unreadable',
    defaultSuffix: ' (default)',
    overwrite: 'Replace existing values',
    overwriteHint: 'Off: only keys a bot does not have yet are copied.',
    copy: 'Copy keys',
    copying: 'Copying…',
    selectTargets: 'Select at least one bot.',
    loading: 'Loading profiles…',
    loadFailed: 'Could not load profile data',
    copyFailed: 'Could not copy provider keys',
    retry: 'Retry',
    copiedTitle: 'Provider keys copied',
    copied: (keys, profiles) =>
      `Copied ${keys} ${keys === 1 ? 'key' : 'keys'} to ${profiles} ${profiles === 1 ? 'bot' : 'bots'}.`,
    nothingNew: 'Nothing new to copy — every selected bot already has these keys.',
    partialTitle: 'Some keys could not be copied',
    partial: n => `${n} ${n === 1 ? 'key copy' : 'key copies'} failed.`
  }
}

function TargetBadges({ target, t }) {
  if (target.error) {
    return jsx(Badge, { variant: 'destructive', size: 'xs', children: t('unreadable') })
  }
  if (target.missing.length > 0) {
    return jsx(Badge, {
      variant: 'warn',
      size: 'xs',
      children: target.missing.length === 1 ? t('missingOne') : t('missing', target.missing.length)
    })
  }
  return jsx(Badge, { variant: 'success', size: 'xs', children: t('upToDate') })
}

function TargetRow({ target, checked, disabled, onToggle, t }) {
  const blocked = Boolean(target.error)
  return jsxs('div', {
    className: cn(
      'flex items-center gap-3 rounded-md border border-border px-3 py-2',
      blocked ? 'opacity-60' : 'cursor-pointer select-none'
    ),
    onClick: () => {
      if (!blocked && !disabled) onToggle(!checked)
    },
    children: [
      jsx(Checkbox, {
        checked,
        disabled: disabled || blocked,
        onCheckedChange: value => onToggle(value === true)
      }),
      jsxs('span', {
        className: 'flex min-w-0 flex-1 items-baseline gap-2',
        children: [
          jsx('span', { className: 'truncate text-sm font-medium', children: target.label }),
          target.label !== target.name
            ? jsx('span', {
                className: 'truncate font-mono text-[0.68rem] text-muted-foreground',
                children: target.name
              })
            : null
        ]
      }),
      jsx(TargetBadges, { target, t })
    ]
  })
}

function Page({ ctx }) {
  const t = usePluginI18n(ID)
  const queryClient = useQueryClient()

  // null until the user picks: the backend resolves the default (the app's
  // active profile) and reports it back as `data.source`.
  const [source, setSource] = useState(null)
  const [deselected, setDeselected] = useState({})
  const [overwrite, setOverwrite] = useState(false)

  const overview = useQuery({
    queryKey: [ID, 'overview', source ?? ''],
    queryFn: () => ctx.rest(`/overview${source ? `?source=${encodeURIComponent(source)}` : ''}`),
    // Keep the page painted while a source switch refetches — a flash back to
    // the loading state on every picker change reads as a bug.
    placeholderData: previous => previous,
    staleTime: 10_000
  })

  const copy = useMutation({
    mutationFn: payload => ctx.rest('/copy', { method: 'POST', body: payload }),
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: [ID] })
      const copied = result.results.reduce((n, r) => n + r.copied.length, 0)
      const failed = result.results.reduce((n, r) => n + r.failed.length + (r.error ? 1 : 0), 0)
      const touched = result.results.filter(r => r.copied.length > 0).length
      if (failed > 0) {
        host.notifyError(new Error(t('partial', failed)), t('partialTitle'))
      } else if (copied === 0) {
        host.notify({ kind: 'info', title: t('copiedTitle'), message: t('nothingNew') })
      } else {
        host.notify({ kind: 'success', title: t('copiedTitle'), message: t('copied', copied, touched) })
      }
    },
    onError: error => host.notifyError(error, t('copyFailed'))
  })

  if (overview.isPending) {
    return jsx('div', {
      className: 'grid h-full place-items-center',
      children: jsx(EmptyState, { title: t('loading') })
    })
  }

  if (overview.isError || !overview.data) {
    const detail = overview.error && overview.error.message ? String(overview.error.message) : ''
    return jsx('div', {
      className: 'grid h-full place-items-center',
      children: jsxs('div', {
        className: 'grid justify-items-center gap-3',
        children: [
          jsx(EmptyState, { title: t('loadFailed'), description: detail }),
          jsx(Button, { variant: 'outline', size: 'sm', onClick: () => overview.refetch(), children: t('retry') })
        ]
      })
    })
  }

  const data = overview.data
  const keys = data.keys
  const targets = data.targets
  const chosen = targets.filter(target => !deselected[target.name] && !target.error)
  const busy = copy.isPending
  const canCopy = keys.length > 0 && chosen.length > 0 && !busy && !overview.isFetching

  const runCopy = () => {
    if (!canCopy) return
    haptic()
    copy.mutate({
      source: source ?? data.source,
      targets: chosen.map(target => target.name),
      overwrite
    })
  }

  const body = jsxs('div', {
    className: 'flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5',
    children: [
      // Source picker — which profile the keys come from.
      jsxs('div', {
        className: 'grid gap-1.5',
        children: [
          jsx('div', { className: 'text-xs font-medium text-muted-foreground', children: t('sourceLabel') }),
          jsxs(Select, {
            value: source ?? data.source,
            onValueChange: value => setSource(value),
            children: [
              jsx(SelectTrigger, {
                className: 'w-72',
                size: 'sm',
                disabled: busy,
                children: jsx(SelectValue, {})
              }),
              jsx(SelectContent, {
                children: data.profiles.map(profile =>
                  jsx(
                    SelectItem,
                    {
                      value: profile.name,
                      children: profile.is_default
                        ? `${profile.label}${t('defaultSuffix')}`
                        : profile.label
                    },
                    profile.name
                  )
                )
              })
            ]
          })
        ]
      }),
      // Keys the source profile has to offer.
      jsxs('div', {
        className: 'grid gap-1.5',
        children: [
          jsx('div', {
            className: 'text-xs font-medium text-muted-foreground',
            children: keys.length === 1 ? t('keysReadyOne') : t('keysReady', keys.length)
          }),
          keys.length > 0
            ? jsx('div', {
                className: 'flex flex-wrap gap-1.5',
                children: keys.map(key =>
                  jsx(
                    'code',
                    {
                      className: 'rounded-[4px] bg-muted px-1.5 py-0.5 font-mono text-[0.68rem] text-muted-foreground',
                      children: key
                    },
                    key
                  )
                )
              })
            : jsx(EmptyState, {
                title: t('noKeys'),
                description: t('noKeysHint'),
                className: 'min-h-0 px-5 py-6'
              })
        ]
      }),
      // Targets.
      targets.length > 0
        ? jsxs('div', {
            className: 'grid gap-1.5',
            children: [
              jsx('div', { className: 'text-xs font-medium text-muted-foreground', children: t('targetsLabel') }),
              jsx('div', {
                className: 'grid gap-1.5',
                children: targets.map(target =>
                  jsx(
                    TargetRow,
                    {
                      target,
                      checked: !deselected[target.name] && !target.error,
                      disabled: busy,
                      onToggle: next =>
                        setDeselected(previous => ({ ...previous, [target.name]: !next })),
                      t
                    },
                    target.name
                  )
                )
              })
            ]
          })
        : null,
      // Overwrite opt-in.
      jsxs('div', {
        className: cn('flex items-start gap-3', busy ? 'opacity-60' : 'cursor-pointer select-none'),
        onClick: () => {
          if (!busy) setOverwrite(value => !value)
        },
        children: [
          jsx(Checkbox, {
            checked: overwrite,
            disabled: busy,
            onCheckedChange: value => setOverwrite(value === true)
          }),
          jsxs('span', {
            className: 'grid gap-0.5',
            children: [
              jsx('span', { className: 'text-sm font-medium', children: t('overwrite') }),
              jsx('span', { className: 'text-xs text-muted-foreground', children: t('overwriteHint') })
            ]
          })
        ]
      })
    ]
  })

  const footer = jsxs('div', {
    className: 'flex items-center justify-between gap-3 border-t border-border px-5 py-3',
    children: [
      jsx('div', { className: 'min-w-0 text-xs text-muted-foreground', children: t('neverCopied') }),
      jsxs('div', {
        className: 'flex shrink-0 items-center gap-3',
        children: [
          chosen.length === 0 && keys.length > 0
            ? jsx('span', { className: 'text-xs text-muted-foreground', children: t('selectTargets') })
            : null,
          jsx(Button, {
            disabled: !canCopy,
            onClick: runCopy,
            children: busy ? t('copying') : t('copy')
          })
        ]
      })
    ]
  })

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      jsxs('div', {
        className: 'flex flex-col gap-1 border-b border-border px-5 py-4',
        children: [
          jsx('div', { className: 'text-sm font-semibold', children: t('title') }),
          jsx('div', { className: 'text-xs text-muted-foreground', children: t('subtitle') })
        ]
      }),
      body,
      footer
    ]
  })
}

const plugin = {
  id: ID,
  name: 'Provider Copy',
  description: 'Copy provider keys from one profile onto your other profiles — a one-time, explicit copy.',
  register(ctx) {
    ctx.i18n.register(STRINGS)

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: NAV_PATH },
        render: () => jsx(Page, { ctx })
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 55,
        data: { codicon: 'copy', label: ctx.i18n.t('nav'), path: NAV_PATH }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'provider-copy.open',
          label: ctx.i18n.t('openCommand'),
          keywords: ['provider', 'copy', 'keys', 'api key', 'credentials', 'profiles', 'bots'],
          run: () => host.navigate(NAV_PATH)
        }
      }
    ])
  }
}

export default plugin

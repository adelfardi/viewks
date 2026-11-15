import { api } from './api'
import type { AppCtx } from './store'

function guardProd(app: AppCtx, name: string) {
  return app.ctxInfo?.prod ? name : undefined
}

export async function deleteObject(app: AppCtx, res: string, name: string, ns?: string, kind = 'objet') {
  const ok = await app.confirm({
    title: `Supprimer ${kind}`,
    message: (
      <>
        Supprimer <b>{name}</b>
        {ns ? <> dans <b>{ns}</b></> : null} sur <b>{app.ctx}</b> ?
      </>
    ),
    confirmLabel: 'Supprimer',
    danger: true,
    typeToConfirm: guardProd(app, name),
  })
  if (!ok) return false
  try {
    await api.del(app.ctx, res, name, ns)
    app.toast(`${name} supprimé`, 'ok')
    app.refresh()
    return true
  } catch (e) {
    app.fail(e)
    return false
  }
}

export async function scaleObject(app: AppCtx, res: string, name: string, ns: string | undefined, current?: number) {
  const v = await app.prompt({
    title: `Scale ${name}`,
    label: 'Nombre de réplicas',
    type: 'number',
    initial: String(current ?? 1),
    confirmLabel: 'Appliquer',
  })
  if (v === null) return
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) return app.toast('Valeur invalide', 'bad')
  if (app.ctxInfo?.prod && n === 0) {
    const ok = await app.confirm({ title: 'Scale à 0 en PROD', message: <>Arrêter totalement <b>{name}</b> ?</>, danger: true, typeToConfirm: name })
    if (!ok) return
  }
  try {
    await api.patch(app.ctx, res, name, ns, { spec: { replicas: n } })
    app.toast(`${name} → ${n} réplica(s)`, 'ok')
    app.refresh()
  } catch (e) {
    app.fail(e)
  }
}

export async function restartObject(app: AppCtx, res: string, name: string, ns?: string) {
  const ok = await app.confirm({
    title: 'Rollout restart',
    message: <>Redémarrer progressivement les pods de <b>{name}</b> ?</>,
    confirmLabel: 'Redémarrer',
    typeToConfirm: guardProd(app, name),
  })
  if (!ok) return
  try {
    await api.patch(app.ctx, res, name, ns, {
      spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } },
    })
    app.toast(`Rollout restart de ${name} lancé`, 'ok')
    app.refresh()
  } catch (e) {
    app.fail(e)
  }
}

export async function triggerCron(app: AppCtx, name: string, ns: string) {
  const ok = await app.confirm({ title: 'Lancer le CronJob', message: <>Créer un Job manuel depuis <b>{name}</b> ?</>, confirmLabel: 'Lancer' })
  if (!ok) return
  try {
    const r = await api.triggerCron(app.ctx, ns, name)
    app.toast(`Job ${r.job} créé`, 'ok')
    app.refresh()
  } catch (e) {
    app.fail(e)
  }
}

export async function suspendCron(app: AppCtx, name: string, ns: string, suspend: boolean) {
  try {
    await api.patch(app.ctx, 'cronjobs.batch', name, ns, { spec: { suspend } })
    app.toast(`${name} ${suspend ? 'suspendu' : 'réactivé'}`, 'ok')
    app.refresh()
  } catch (e) {
    app.fail(e)
  }
}

export async function cordonNode(app: AppCtx, name: string, cordon: boolean) {
  const ok = await app.confirm({
    title: cordon ? 'Cordon' : 'Uncordon',
    message: <>{cordon ? 'Empêcher' : 'Autoriser'} le scheduling de nouveaux pods sur <b>{name}</b> ?</>,
    confirmLabel: cordon ? 'Cordon' : 'Uncordon',
  })
  if (!ok) return
  try {
    await api.patch(app.ctx, 'nodes', name, undefined, { spec: { unschedulable: cordon ? true : null } })
    app.toast(`${name} ${cordon ? 'cordonné' : 'décordonné'}`, 'ok')
    app.refresh()
  } catch (e) {
    app.fail(e)
  }
}

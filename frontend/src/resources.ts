import {
  Activity, Box, Boxes, Briefcase, Clock, Cpu, Database, FileCode2, Gauge, Globe, HardDrive, KeyRound,
  Layers, LayoutDashboard, type LucideIcon, Network, Puzzle, Server, Shield, UserCog, Workflow,
} from 'lucide-react'

export interface NavItem { id: string; label: string; icon: LucideIcon; kind?: string }
export interface NavGroup { title: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  {
    title: 'Cluster',
    items: [
      { id: 'overview', label: "Vue d'ensemble", icon: LayoutDashboard },
      { id: 'nodes', label: 'Nodes', icon: Server, kind: 'Node' },
      { id: 'namespaces', label: 'Namespaces', icon: Layers, kind: 'Namespace' },
      { id: 'events', label: 'Events', icon: Activity },
    ],
  },
  {
    title: 'Workloads',
    items: [
      { id: 'pods', label: 'Pods', icon: Box, kind: 'Pod' },
      { id: 'deployments.apps', label: 'Deployments', icon: Boxes, kind: 'Deployment' },
      { id: 'statefulsets.apps', label: 'StatefulSets', icon: Database, kind: 'StatefulSet' },
      { id: 'daemonsets.apps', label: 'DaemonSets', icon: Cpu, kind: 'DaemonSet' },
      { id: 'replicasets.apps', label: 'ReplicaSets', icon: Workflow, kind: 'ReplicaSet' },
      { id: 'jobs.batch', label: 'Jobs', icon: Briefcase, kind: 'Job' },
      { id: 'cronjobs.batch', label: 'CronJobs', icon: Clock, kind: 'CronJob' },
      { id: 'horizontalpodautoscalers.autoscaling', label: 'HPA', icon: Gauge, kind: 'HorizontalPodAutoscaler' },
    ],
  },
  {
    title: 'Réseau',
    items: [
      { id: 'services', label: 'Services', icon: Network, kind: 'Service' },
      { id: 'ingresses.networking.k8s.io', label: 'Ingresses', icon: Globe, kind: 'Ingress' },
      { id: 'networkpolicies.networking.k8s.io', label: 'NetworkPolicies', icon: Shield, kind: 'NetworkPolicy' },
    ],
  },
  {
    title: 'Config & stockage',
    items: [
      { id: 'configmaps', label: 'ConfigMaps', icon: FileCode2, kind: 'ConfigMap' },
      { id: 'secrets', label: 'Secrets', icon: KeyRound, kind: 'Secret' },
      { id: 'serviceaccounts', label: 'ServiceAccounts', icon: UserCog, kind: 'ServiceAccount' },
      { id: 'persistentvolumeclaims', label: 'PVC', icon: HardDrive, kind: 'PersistentVolumeClaim' },
      { id: 'persistentvolumes', label: 'PV', icon: HardDrive, kind: 'PersistentVolume' },
    ],
  },
  {
    title: 'Avancé',
    items: [{ id: 'custom', label: 'Autres ressources…', icon: Puzzle }],
  },
]

export function navLabel(id: string) {
  for (const g of NAV) for (const i of g.items) if (i.id === id) return i.label
  return id
}

/** resource id (as used by the API) for a kind found in ownerRefs / events */
export const KIND_TO_RES: Record<string, string> = {
  Pod: 'pods', Deployment: 'deployments.apps', StatefulSet: 'statefulsets.apps', DaemonSet: 'daemonsets.apps',
  ReplicaSet: 'replicasets.apps', Job: 'jobs.batch', CronJob: 'cronjobs.batch', Service: 'services',
  Ingress: 'ingresses.networking.k8s.io', ConfigMap: 'configmaps', Secret: 'secrets', Node: 'nodes',
  Namespace: 'namespaces', PersistentVolumeClaim: 'persistentvolumeclaims', PersistentVolume: 'persistentvolumes',
  HorizontalPodAutoscaler: 'horizontalpodautoscalers.autoscaling', ServiceAccount: 'serviceaccounts',
}

export const SCALABLE = new Set(['deployments.apps', 'statefulsets.apps', 'replicasets.apps'])
export const RESTARTABLE = new Set(['deployments.apps', 'statefulsets.apps', 'daemonsets.apps'])

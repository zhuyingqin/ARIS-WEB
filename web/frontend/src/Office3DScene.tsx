import { useEffect, useMemo, useRef, useState } from "react"
import * as THREE from "three"
import { Activity, ClipboardCheck, MousePointer2 } from "lucide-react"
import type { TeamRoleKind } from "./types"

export type Office3DDeskStatus = "running" | "review" | "blocked" | "done" | "idle"

export type Office3DDesk = {
  role: string
  kind: TeamRoleKind
  status: Office3DDeskStatus
  statusLabel: string
  taskName: string
  taskStatus: string
  total: number
  active: number
  review: number
  done: number
  left: string
  top: string
  selected: boolean
  taskId: string
}

export type Office3DProblem = {
  id: string
  title: string
  status: string
  route: string
}

export type Office3DSignal = {
  key: string
  timestamp: string
  actor: string
  title: string
  tone: "planner" | "problem" | "worker" | "reviewer" | "runtime"
  nodeId: string
}

type Office3DSceneProps = {
  desks: Office3DDesk[]
  problems: Office3DProblem[]
  signals: Office3DSignal[]
  activeCount: number
  openIssueCount: number
  artifactCount: number
  executionLabel: string
  onSelectDesk: (desk: Office3DDesk) => void
  onOpenProblem: (problem: Office3DProblem) => void
  onOpenSignal: (signal: Office3DSignal) => void
}

const ROLE_COLORS: Record<TeamRoleKind, number> = {
  planner: 0x477465,
  literature: 0x315f8a,
  writer: 0x5f8f52,
  citation: 0x5f8f52,
  reviewer: 0xb67824,
  worker: 0x3f7c70,
  gate: 0x7b6f91,
}

const STATUS_EMISSIVE: Record<Office3DDeskStatus, number> = {
  running: 0x5ba48f,
  review: 0xd39a39,
  blocked: 0xbd3d42,
  done: 0x6a8a7e,
  idle: 0x7b837f,
}

const KIND_POSITIONS: Record<TeamRoleKind, THREE.Vector3> = {
  planner: new THREE.Vector3(0, 0, -1.7),
  literature: new THREE.Vector3(-3.2, 0, -0.35),
  writer: new THREE.Vector3(3.25, 0, -0.25),
  reviewer: new THREE.Vector3(0.2, 0, 2.0),
  citation: new THREE.Vector3(-2.8, 0, 2.25),
  worker: new THREE.Vector3(2.9, 0, 2.25),
  gate: new THREE.Vector3(0, 0, 3.25),
}

const LABEL_POSITIONS: Partial<Record<TeamRoleKind, { left: string; top: string }>> = {
  planner: { left: "53%", top: "33%" },
  literature: { left: "25%", top: "49%" },
  writer: { left: "79%", top: "49%" },
  reviewer: { left: "42%", top: "66%" },
  citation: { left: "24%", top: "72%" },
  worker: { left: "76%", top: "72%" },
  gate: { left: "53%", top: "80%" },
}

function truncateText(value: string, limit: number) {
  const text = value.trim()
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text
}

function material(color: number, options: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.72,
    metalness: 0.04,
    ...options,
  })
}

function roundedBox(width: number, height: number, depth: number, color: number, options: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material(color, options))
}

function canvasTexture(lines: string[], options: { title: string; width?: number; height?: number; bg?: string }) {
  const canvas = document.createElement("canvas")
  canvas.width = options.width ?? 1024
  canvas.height = options.height ?? 640
  const ctx = canvas.getContext("2d")
  if (!ctx) return new THREE.CanvasTexture(canvas)
  const bg = options.bg ?? "#24443d"
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = "rgba(255,255,255,0.08)"
  for (let y = 72; y < canvas.height; y += 70) ctx.fillRect(56, y, canvas.width - 112, 2)
  ctx.font = "700 64px Inter, Arial, sans-serif"
  ctx.fillStyle = "#f6fff8"
  ctx.fillText(options.title, 58, 88)
  ctx.font = "650 42px Inter, Arial, sans-serif"
  ctx.fillStyle = "#d8efe6"
  lines.slice(0, 5).forEach((line, index) => {
    const y = 164 + index * 84
    ctx.fillStyle = index === 0 ? "#fff8d6" : "#d8efe6"
    ctx.fillText(`• ${truncateText(line, 34)}`, 76, y)
  })
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

function addCylinder(parent: THREE.Group, radius: number, height: number, color: number, position: THREE.Vector3, rotation: THREE.Euler) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 18), material(color))
  mesh.position.copy(position)
  mesh.rotation.copy(rotation)
  mesh.castShadow = true
  parent.add(mesh)
  return mesh
}

function createPerson(kind: TeamRoleKind, status: Office3DDeskStatus) {
  const root = new THREE.Group()
  const color = ROLE_COLORS[kind] ?? ROLE_COLORS.worker
  const glow = STATUS_EMISSIVE[status]
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.22, 0.38, 8, 18),
    material(color, { emissive: glow, emissiveIntensity: status === "running" || status === "review" ? 0.16 : 0.04 }),
  )
  body.position.set(0, 0.86, 0.02)
  body.castShadow = true
  root.add(body)

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 24, 18), material(0xd7b383))
  head.position.set(0, 1.27, 0.03)
  head.castShadow = true
  root.add(head)

  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), material(0x1d2727))
  hair.position.set(0, 1.37, 0.02)
  hair.castShadow = true
  root.add(hair)

  const leftArm = addCylinder(root, 0.045, 0.48, 0xd7b383, new THREE.Vector3(-0.28, 0.88, 0.1), new THREE.Euler(0.35, 0, 0.55))
  const rightArm = addCylinder(root, 0.045, 0.48, 0xd7b383, new THREE.Vector3(0.28, 0.88, 0.1), new THREE.Euler(0.35, 0, -0.55))
  const leftLeg = addCylinder(root, 0.055, 0.38, 0x2f3432, new THREE.Vector3(-0.13, 0.46, 0.05), new THREE.Euler(0.2, 0, 0.18))
  const rightLeg = addCylinder(root, 0.055, 0.38, 0x2f3432, new THREE.Vector3(0.13, 0.46, 0.05), new THREE.Euler(0.2, 0, -0.18))
  root.userData.leftArm = leftArm
  root.userData.rightArm = rightArm
  root.userData.leftLeg = leftLeg
  root.userData.rightLeg = rightLeg
  return root
}

function addRoleProp(parent: THREE.Group, kind: TeamRoleKind) {
  if (kind === "literature") {
    const lens = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.025, 10, 28), material(0x88a7a4, { metalness: 0.18 }))
    lens.position.set(-0.42, 0.78, 0.05)
    lens.rotation.set(Math.PI / 2.5, 0, -0.28)
    parent.add(lens)
    addCylinder(parent, 0.022, 0.32, 0x88a7a4, new THREE.Vector3(-0.26, 0.66, 0.07), new THREE.Euler(1.2, 0, -0.76))
    return
  }
  if (kind === "planner") {
    const board = roundedBox(0.82, 0.48, 0.04, 0xdfeee8)
    board.position.set(-0.43, 0.92, -0.28)
    parent.add(board)
    for (let i = 0; i < 3; i += 1) {
      const sticky = roundedBox(0.16, 0.12, 0.018, [0xb8e5c8, 0xf1dc8e, 0xc8d8ff][i])
      sticky.position.set(-0.68 + i * 0.22, 0.98 - (i % 2) * 0.15, -0.245)
      parent.add(sticky)
    }
    return
  }
  if (kind === "reviewer") {
    const sheet = roundedBox(0.45, 0.62, 0.025, 0xfff9e8)
    sheet.position.set(-0.39, 0.74, 0.02)
    sheet.rotation.z = 0.08
    parent.add(sheet)
    const mark = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.018, 10, 28, Math.PI * 1.45), material(0x4f8d67))
    mark.position.set(-0.4, 0.74, 0.045)
    mark.rotation.set(0, 0, -0.75)
    parent.add(mark)
    return
  }
  const doc = roundedBox(0.44, 0.58, 0.022, 0xf8f2e2)
  doc.position.set(-0.38, 0.74, 0.04)
  doc.rotation.z = -0.08
  parent.add(doc)
  const pen = roundedBox(0.04, 0.42, 0.035, 0xb67824)
  pen.position.set(-0.08, 0.74, 0.09)
  pen.rotation.z = -0.7
  parent.add(pen)
}

function createDesk(desk: Office3DDesk, index: number) {
  const group = new THREE.Group()
  const base = KIND_POSITIONS[desk.kind] ?? KIND_POSITIONS.worker
  group.position.set(base.x + (index % 2 ? 0.4 : -0.2) * Math.floor(index / 6), 0, base.z)
  group.userData.role = desk.role
  group.rotation.y = base.z < 0 ? 0 : Math.PI

  const deskTop = roundedBox(1.28, 0.12, 0.76, 0xf4f2ea, { emissive: STATUS_EMISSIVE[desk.status], emissiveIntensity: desk.selected ? 0.16 : 0.02 })
  deskTop.position.set(0, 0.55, 0)
  deskTop.castShadow = true
  deskTop.receiveShadow = true
  group.add(deskTop)
  ;[
    [-0.52, 0.28, -0.28],
    [0.52, 0.28, -0.28],
    [-0.52, 0.28, 0.28],
    [0.52, 0.28, 0.28],
  ].forEach(([x, y, z]) => {
    const leg = roundedBox(0.07, 0.48, 0.07, 0xcfd8d2)
    leg.position.set(x, y, z)
    leg.castShadow = true
    group.add(leg)
  })

  const screen = roundedBox(0.62, 0.42, 0.05, 0x273233, { emissive: STATUS_EMISSIVE[desk.status], emissiveIntensity: desk.status === "running" ? 0.34 : 0.12 })
  screen.position.set(0.18, 0.92, -0.22)
  screen.castShadow = true
  group.add(screen)
  const screenFace = roundedBox(0.52, 0.31, 0.012, 0x9eb8ff, { emissive: 0x5c7cff, emissiveIntensity: 0.35 })
  screenFace.position.set(0.18, 0.92, -0.253)
  group.add(screenFace)

  const person = createPerson(desk.kind, desk.status)
  person.position.set(0.08, 0.04, 0.35)
  group.add(person)
  group.userData.person = person
  addRoleProp(group, desk.kind)

  const statusLamp = new THREE.Mesh(new THREE.SphereGeometry(0.08, 18, 12), material(STATUS_EMISSIVE[desk.status], { emissive: STATUS_EMISSIVE[desk.status], emissiveIntensity: 0.85 }))
  statusLamp.position.set(0.57, 0.66, -0.22)
  group.add(statusLamp)
  return group
}

function addRoom(scene: THREE.Scene, problemTexture: THREE.Texture) {
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(9.2, 7.2, 32, 32),
    material(0xe9eee8, { roughness: 0.88 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  scene.add(floor)

  const backWall = roundedBox(9.2, 3.6, 0.14, 0xf8faf5)
  backWall.position.set(0, 1.8, -3.6)
  backWall.receiveShadow = true
  scene.add(backWall)
  const leftWall = roundedBox(0.14, 3.6, 7.2, 0xf1f5ef)
  leftWall.position.set(-4.6, 1.8, 0)
  leftWall.receiveShadow = true
  scene.add(leftWall)

  const windowFrame = roundedBox(1.5, 1.1, 0.04, 0xdfe9ee, { transparent: true, opacity: 0.88 })
  windowFrame.position.set(-3.15, 2.25, -3.51)
  scene.add(windowFrame)
  const shelf = roundedBox(1.7, 0.08, 0.22, 0xd6cec0)
  shelf.position.set(3.05, 2.7, -3.45)
  scene.add(shelf)
  for (let i = 0; i < 5; i += 1) {
    const book = roundedBox(0.12, 0.42, 0.18, [0x6d8f82, 0xc29642, 0x6e83b7, 0xa65b54, 0x58766d][i])
    book.position.set(2.45 + i * 0.18, 2.93, -3.31)
    scene.add(book)
  }

  const blackboard = new THREE.Mesh(new THREE.PlaneGeometry(3.45, 1.62), material(0xffffff, { map: problemTexture, roughness: 0.6 }))
  blackboard.position.set(0, 2.08, -3.515)
  scene.add(blackboard)
  const frame = roundedBox(3.62, 1.78, 0.06, 0x8c7a58)
  frame.position.set(0, 2.08, -3.54)
  scene.add(frame)
  blackboard.position.z = -3.49
}

function createPacket(color: number) {
  const group = new THREE.Group()
  const body = roundedBox(0.2, 0.15, 0.03, 0xffffff, { emissive: color, emissiveIntensity: 0.15 })
  const seal = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), material(color, { emissive: color, emissiveIntensity: 0.5 }))
  seal.position.set(0.07, 0.015, 0.028)
  group.add(body, seal)
  return group
}

function createWalkingTeammate(status: Office3DDeskStatus) {
  const teammate = createPerson("worker", status)
  teammate.scale.setScalar(0.72)
  const clipboard = roundedBox(0.2, 0.3, 0.025, 0xf8f2e2)
  clipboard.position.set(0.32, 0.9, 0.15)
  clipboard.rotation.set(0.3, -0.2, -0.18)
  teammate.add(clipboard)
  const satchel = roundedBox(0.28, 0.22, 0.08, 0xc98b36)
  satchel.position.set(-0.25, 0.78, 0.03)
  teammate.add(satchel)
  return teammate
}

function buildSignalCurves(scene: THREE.Scene, desks: Office3DDesk[]) {
  const available = new Map(desks.map((desk) => [desk.kind, KIND_POSITIONS[desk.kind] ?? KIND_POSITIONS.worker]))
  const routes: [TeamRoleKind, TeamRoleKind, number][] = [
    ["planner", "literature", 0x4d7f73],
    ["literature", "writer", 0x3d73ad],
    ["writer", "reviewer", 0x5f9854],
    ["reviewer", "planner", 0xc28a35],
    ["planner", "worker", 0x4d7f73],
  ]
  const packets: { mesh: THREE.Group; curve: THREE.CatmullRomCurve3; offset: number; speed: number }[] = []
  routes.forEach(([from, to, color], index) => {
    const source = available.get(from)
    const target = available.get(to)
    if (!source || !target) return
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(source.x, 1.0, source.z),
      new THREE.Vector3((source.x + target.x) / 2, 1.75 + (index % 2) * 0.24, (source.z + target.z) / 2),
      new THREE.Vector3(target.x, 1.0, target.z),
    ])
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(curve.getPoints(42)),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.28 }),
    )
    scene.add(line)
    const packet = createPacket(color)
    scene.add(packet)
    packets.push({ mesh: packet, curve, offset: index / Math.max(routes.length, 1), speed: 0.075 + index * 0.008 })
  })
  return packets
}

export function Office3DScene({
  desks,
  problems,
  signals,
  activeCount,
  openIssueCount,
  artifactCount,
  executionLabel,
  onSelectDesk,
  onOpenProblem,
  onOpenSignal,
}: Office3DSceneProps) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const onSelectDeskRef = useRef(onSelectDesk)
  const [webglUnavailable, setWebglUnavailable] = useState(false)
  const selectedDesk = desks.find((desk) => desk.selected) ?? desks[0]
  const labelPositionFor = (desk: Office3DDesk) => LABEL_POSITIONS[desk.kind] ?? { left: desk.left, top: desk.top }
  const sceneKey = useMemo(
    () =>
      JSON.stringify({
        desks: desks.map((desk) => [desk.role, desk.kind, desk.status, desk.selected, desk.taskName]),
        problems: problems.map((problem) => [problem.id, problem.title, problem.status]),
        signals: signals.map((signal) => [signal.key, signal.actor, signal.title]),
      }),
    [desks, problems, signals],
  )

  useEffect(() => {
    onSelectDeskRef.current = onSelectDesk
  }, [onSelectDesk])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const width = Math.max(640, mount.clientWidth)
    const height = Math.max(460, mount.clientHeight)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf6f8f4)
    scene.fog = new THREE.Fog(0xf6f8f4, 8, 16)

    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 60)
    camera.position.set(0, 5.8, 7.6)
    camera.lookAt(0, 0.8, -0.35)

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true })
      setWebglUnavailable(false)
    } catch {
      setWebglUnavailable(true)
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    mount.appendChild(renderer.domElement)

    const ambient = new THREE.HemisphereLight(0xffffff, 0xcdd7cf, 1.45)
    scene.add(ambient)
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.35)
    keyLight.position.set(-3.2, 7.2, 3.8)
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(1536, 1536)
    scene.add(keyLight)
    const warmLight = new THREE.PointLight(0xffe3ad, 0.65, 8)
    warmLight.position.set(3.4, 2.6, 1.6)
    scene.add(warmLight)

    const boardLines = problems.length
      ? problems.map((problem) => `${problem.title} · ${problem.status}`)
      : ["No open blockers", "Planner watches useful new signals"]
    const problemTexture = canvasTexture(boardLines, { title: `Problem Board (${openIssueCount})` })
    addRoom(scene, problemTexture)

    const selectable: THREE.Object3D[] = []
    const animatedPeople: THREE.Object3D[] = []
    desks.slice(0, 7).forEach((desk, index) => {
      const deskGroup = createDesk(desk, index)
      scene.add(deskGroup)
      selectable.push(deskGroup)
      if (deskGroup.userData.person) animatedPeople.push(deskGroup.userData.person as THREE.Object3D)
    })

    const packets = buildSignalCurves(scene, desks)
    const courierCurve = new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3(-3.25, 0, -0.95),
        new THREE.Vector3(-1.35, 0, -1.65),
        new THREE.Vector3(1.55, 0, -1.25),
        new THREE.Vector3(3.25, 0, -0.75),
        new THREE.Vector3(2.55, 0, 1.55),
        new THREE.Vector3(0.15, 0, 2.35),
        new THREE.Vector3(-2.75, 0, 1.4),
      ],
      true,
    )
    const walkingTeammate = createWalkingTeammate(activeCount > 0 ? "running" : "idle")
    scene.add(walkingTeammate)
    const sharedTable = roundedBox(1.6, 0.12, 0.9, 0xe2e7df, { emissive: 0x8fa79a, emissiveIntensity: 0.04 })
    sharedTable.position.set(0, 0.46, 0.32)
    sharedTable.castShadow = true
    scene.add(sharedTable)
    for (let i = 0; i < 4; i += 1) {
      const doc = roundedBox(0.34, 0.035, 0.46, [0xf8f5e8, 0xdcecff, 0xf7dfae, 0xdff1e3][i])
      doc.position.set(-0.48 + i * 0.32, 0.56 + i * 0.018, 0.32 + (i % 2) * 0.15)
      doc.rotation.y = (i - 1.5) * 0.12
      scene.add(doc)
    }

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const handlePointerDown = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObjects(selectable, true)[0]
      let object: THREE.Object3D | null = hit?.object ?? null
      while (object && !object.userData.role) object = object.parent
      const role = object?.userData.role
      if (typeof role === "string") {
        const desk = desks.find((item) => item.role === role)
        if (desk) onSelectDeskRef.current(desk)
      }
    }
    renderer.domElement.addEventListener("pointerdown", handlePointerDown)

    let animationFrame = 0
    const clock = new THREE.Clock()
    const animate = () => {
      const elapsed = clock.getElapsedTime()
      animatedPeople.forEach((person, index) => {
        person.position.y = 0.04 + Math.sin(elapsed * 2.2 + index) * 0.025
        person.rotation.z = Math.sin(elapsed * 1.8 + index * 0.8) * 0.025
        const leftArm = person.userData.leftArm as THREE.Object3D | undefined
        const rightArm = person.userData.rightArm as THREE.Object3D | undefined
        if (leftArm) leftArm.rotation.z = 0.55 + Math.sin(elapsed * 1.9 + index) * 0.08
        if (rightArm) rightArm.rotation.z = -0.55 - Math.sin(elapsed * 1.9 + index) * 0.08
      })
      const courierT = (elapsed * 0.055) % 1
      const courierPoint = courierCurve.getPointAt(courierT)
      const courierNext = courierCurve.getPointAt((courierT + 0.012) % 1)
      walkingTeammate.position.copy(courierPoint)
      walkingTeammate.position.y = Math.sin(elapsed * 9) * 0.035
      walkingTeammate.lookAt(courierNext.x, walkingTeammate.position.y, courierNext.z)
      const leftLeg = walkingTeammate.userData.leftLeg as THREE.Object3D | undefined
      const rightLeg = walkingTeammate.userData.rightLeg as THREE.Object3D | undefined
      const leftArm = walkingTeammate.userData.leftArm as THREE.Object3D | undefined
      const rightArm = walkingTeammate.userData.rightArm as THREE.Object3D | undefined
      const stride = Math.sin(elapsed * 8)
      if (leftLeg) leftLeg.rotation.z = 0.18 + stride * 0.28
      if (rightLeg) rightLeg.rotation.z = -0.18 - stride * 0.28
      if (leftArm) leftArm.rotation.z = 0.55 - stride * 0.22
      if (rightArm) rightArm.rotation.z = -0.55 + stride * 0.22
      packets.forEach((packet) => {
        const t = (elapsed * packet.speed + packet.offset) % 1
        const point = packet.curve.getPointAt(t)
        packet.mesh.position.copy(point)
        packet.mesh.rotation.y = elapsed * 1.7
        packet.mesh.scale.setScalar(0.85 + Math.sin(elapsed * 5 + packet.offset * 10) * 0.08)
      })
      camera.position.x = Math.sin(elapsed * 0.12) * 0.28
      camera.lookAt(0, 0.88, -0.35)
      renderer.render(scene, camera)
      animationFrame = requestAnimationFrame(animate)
    }
    animate()

    const resizeObserver = new ResizeObserver(([entry]) => {
      const nextWidth = Math.max(640, entry.contentRect.width)
      const nextHeight = Math.max(460, entry.contentRect.height)
      camera.aspect = nextWidth / nextHeight
      camera.updateProjectionMatrix()
      renderer.setSize(nextWidth, nextHeight)
    })
    resizeObserver.observe(mount)

    return () => {
      cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown)
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        mesh.geometry?.dispose()
        const meshMaterial = mesh.material
        if (Array.isArray(meshMaterial)) meshMaterial.forEach((item) => item.dispose())
        else meshMaterial?.dispose()
      })
      problemTexture.dispose()
      renderer.dispose()
    }
  }, [activeCount, openIssueCount, sceneKey])

  return (
    <div className="office-3d-shell">
      <div className="office-3d-canvas" ref={mountRef} />
      {webglUnavailable && (
        <div className="office-3d-fallback" aria-live="polite">
          <strong>3D office preview needs WebGL</strong>
          <span>The team status, Problem Board, and information flow remain available in the overlay.</span>
        </div>
      )}
      <div className="office-3d-topbar">
        <div>
          <strong>ARIS Team Office</strong>
          <span>{activeCount} active · {openIssueCount} open issue(s) · {artifactCount} artifacts</span>
        </div>
        <em>{executionLabel}</em>
      </div>
      <section className="office-3d-board" aria-label="Problem Board">
        <div className="office-3d-board-head">
          <ClipboardCheck size={15} />
          <strong>Problem Board</strong>
          <b>{openIssueCount}</b>
        </div>
        <div className="office-3d-board-list">
          {problems.slice(0, 3).map((problem) => (
            <button className={`office-3d-board-item office-3d-board-item-${problem.status}`} key={problem.id} onClick={() => onOpenProblem(problem)} type="button">
              <strong>{problem.title}</strong>
              <small>{problem.route}</small>
            </button>
          ))}
          {!problems.length && <span>No open blockers</span>}
        </div>
      </section>
      <div className="office-3d-label-layer" aria-label="Team desks">
        {desks.slice(0, 7).map((desk) => (
          <button
            className={`office-3d-role-label office-3d-role-label-${desk.kind}${desk.selected ? " office-3d-role-label-selected" : ""}`}
            key={desk.role}
            onClick={() => onSelectDesk(desk)}
            style={labelPositionFor(desk)}
            type="button"
            aria-label={`${desk.role}: ${desk.statusLabel}`}
          >
            <strong>{desk.role}</strong>
            <span>{desk.statusLabel}</span>
          </button>
        ))}
      </div>
      {selectedDesk && (
        <aside className={`office-3d-detail office-3d-detail-${selectedDesk.kind}`}>
          <div>
            <strong>{selectedDesk.role}</strong>
            <em>{selectedDesk.taskStatus}</em>
          </div>
          <p>{selectedDesk.taskName}</p>
          <span>
            <b>{selectedDesk.active}</b> active
            <b>{selectedDesk.review}</b> review
            <b>{selectedDesk.done}</b> done
          </span>
        </aside>
      )}
      <section className="office-3d-feed" aria-label="Live team signals">
        <div className="office-3d-feed-head">
          <Activity size={15} />
          <strong>Information Flow</strong>
          <MousePointer2 size={13} />
        </div>
        {signals.slice(0, 3).map((signal) => (
          <button className={`office-3d-feed-item office-3d-feed-item-${signal.tone}`} key={signal.key} onClick={() => onOpenSignal(signal)} type="button">
            <span>{signal.timestamp.slice(11, 19)}</span>
            <strong>{signal.actor}</strong>
            <small>{signal.title}</small>
          </button>
        ))}
        {!signals.length && <small>No team activity yet.</small>}
      </section>
    </div>
  )
}

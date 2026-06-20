import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'

const router = Router()

router.get('/', async (_req: Request, res: Response) => {
  const members = await prisma.member.findMany({
    include: { packages: { include: { package: true } } },
    orderBy: { createdAt: 'desc' },
  })
  res.json({ data: members })
})

router.get('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const member = await prisma.member.findUnique({
    where: { id },
    include: {
      packages: { include: { package: true } },
      bookings: { include: { trainer: true, store: true, schedule: true }, orderBy: { createdAt: 'desc' } },
      feedbacks: { orderBy: { createdAt: 'desc' } },
    },
  })
  if (!member) return res.status(404).json({ error: '会员不存在' })
  res.json({ data: member })
})

router.post('/', async (req: Request, res: Response) => {
  const { name, phone, gender, birthday, notes } = req.body
  if (!name || !phone) return res.status(400).json({ error: '姓名和手机号为必填' })
  const existing = await prisma.member.findUnique({ where: { phone } })
  if (existing) return res.status(409).json({ error: '手机号已注册' })
  const member = await prisma.member.create({
    data: { name, phone, gender, birthday: birthday ? new Date(birthday) : undefined, notes },
  })
  res.status(201).json({ data: member })
})

router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { name, phone, gender, birthday, notes } = req.body
  try {
    const member = await prisma.member.update({
      where: { id },
      data: { name, phone, gender, birthday: birthday ? new Date(birthday) : undefined, notes },
    })
    res.json({ data: member })
  } catch {
    res.status(404).json({ error: '会员不存在' })
  }
})

export default router

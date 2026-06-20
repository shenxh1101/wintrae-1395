import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'
import dayjs from 'dayjs'

const router = Router()

router.post('/', async (req: Request, res: Response) => {
  const { memberId, scheduleId, memberPackageId } = req.body
  if (!memberId || !scheduleId || !memberPackageId)
    return res.status(400).json({ error: 'memberId、scheduleId、memberPackageId 为必填' })

  const schedule = await prisma.schedule.findUnique({
    where: { id: Number(scheduleId) },
    include: { trainer: true, store: true },
  })
  if (!schedule) return res.status(404).json({ error: '排班时段不存在' })
  if (!schedule.isBooked) return res.status(400).json({ error: '该时段尚未约满，可直接预约无需候补' })

  const now = new Date()
  if (dayjs(schedule.date).hour(Number(schedule.startAt.split(':')[0])).isBefore(now))
    return res.status(400).json({ error: '该时段已过，不可候补' })

  const mp = await prisma.memberPackage.findUnique({ where: { id: Number(memberPackageId) } })
  if (!mp) return res.status(404).json({ error: '课程包不存在' })
  if (mp.memberId !== Number(memberId)) return res.status(400).json({ error: '课程包不属于该会员' })
  if (mp.remainSlots <= 0) return res.status(400).json({ error: '课时余量不足，无法加入候补' })
  if (mp.expireAt && mp.expireAt < schedule.date) return res.status(400).json({ error: '课程包在该时段前已过期' })

  const existingBooking = await prisma.booking.findFirst({
    where: {
      memberId: Number(memberId),
      status: { in: ['booked', 'checked_in'] },
      schedule: { date: schedule.date, startAt: schedule.startAt },
    },
  })
  if (existingBooking) return res.status(409).json({ error: '您在该时段已有预约' })

  const existingWaitlist = await prisma.waitlist.findFirst({
    where: { memberId: Number(memberId), scheduleId: Number(scheduleId), status: 'waiting' },
  })
  if (existingWaitlist) return res.status(409).json({ error: '您已在该时段的候补队列中' })

  const waitCount = await prisma.waitlist.count({ where: { scheduleId: Number(scheduleId), status: 'waiting' } })
  const waitlist = await prisma.waitlist.create({
    data: {
      memberId: Number(memberId),
      scheduleId: Number(scheduleId),
      memberPackageId: Number(memberPackageId),
      priority: waitCount + 1,
      status: 'waiting',
    },
    include: { member: true, schedule: { include: { trainer: true } } },
  })

  res.status(201).json({
    data: {
      id: waitlist.id,
      memberId: waitlist.memberId,
      scheduleId: waitlist.scheduleId,
      position: waitCount + 1,
      status: waitlist.status,
      trainerName: schedule.trainer.name,
      date: schedule.date,
      startAt: schedule.startAt,
      endAt: schedule.endAt,
    },
  })
})

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const waitlist = await prisma.waitlist.findUnique({ where: { id } })
  if (!waitlist) return res.status(404).json({ error: '候补记录不存在' })
  if (waitlist.status !== 'waiting') return res.status(400).json({ error: '仅等待中候补可取消' })

  await prisma.waitlist.update({ where: { id }, data: { status: 'cancelled' } })

  const schedule = await prisma.schedule.findUnique({ where: { id: waitlist.scheduleId } })
  if (schedule) {
    const remaining = await prisma.waitlist.findMany({
      where: { scheduleId: schedule.id, status: 'waiting', id: { gt: id } },
      orderBy: { priority: 'asc' },
    })
    for (const w of remaining) {
      await prisma.waitlist.update({ where: { id: w.id }, data: { priority: { decrement: 1 } } })
    }
  }

  res.json({ message: '已取消候补' })
})

router.get('/schedule/:scheduleId', async (req: Request, res: Response) => {
  const scheduleId = Number(req.params.scheduleId)
  const waitlist = await prisma.waitlist.findMany({
    where: { scheduleId, status: 'waiting' },
    include: { member: true },
    orderBy: { priority: 'asc' },
  })

  res.json({
    data: waitlist.map((w, i) => ({
      id: w.id,
      position: i + 1,
      memberId: w.memberId,
      memberName: w.member.name,
      memberPhone: w.member.phone,
      joinedAt: w.createdAt,
    })),
  })
})

router.get('/member/:memberId', async (req: Request, res: Response) => {
  const memberId = Number(req.params.memberId)
  const waitlist = await prisma.waitlist.findMany({
    where: { memberId, status: 'waiting' },
    include: { schedule: { include: { trainer: true, store: true } } },
    orderBy: { createdAt: 'desc' },
  })

  const result = await Promise.all(
    waitlist.map(async (w) => {
      const position = await prisma.waitlist.count({
        where: { scheduleId: w.scheduleId, status: 'waiting', priority: { lt: w.priority } },
      })
      return {
        id: w.id,
        scheduleId: w.scheduleId,
        date: w.schedule.date,
        startAt: w.schedule.startAt,
        endAt: w.schedule.endAt,
        trainerName: w.schedule.trainer.name,
        storeName: w.schedule.store.name,
        position: position + 1,
        status: w.status,
        joinedAt: w.createdAt,
      }
    })
  )

  res.json({ data: result })
})

export default router

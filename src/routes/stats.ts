import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'
import dayjs from 'dayjs'

const router = Router()

router.get('/popular-slots', async (req: Request, res: Response) => {
  const { storeId, startDate, endDate } = req.query as Record<string, string>
  const start = startDate ? dayjs(startDate).startOf('day') : dayjs().startOf('day')
  const end = endDate ? dayjs(endDate).endOf('day') : dayjs().add(30, 'day').endOf('day')

  const where: any = { date: { gte: start.toDate(), lte: end.toDate() }, isBooked: true }
  if (storeId) where.storeId = Number(storeId)

  const bookedSlots = await prisma.schedule.findMany({
    where,
    select: { startAt: true, storeId: true, store: { select: { name: true } } },
  })

  const slotCount: Record<string, { count: number; storeName: string }> = {}
  for (const s of bookedSlots) {
    const key = s.startAt
    if (!slotCount[key]) slotCount[key] = { count: 0, storeName: s.store.name }
    slotCount[key].count++
  }

  const result = Object.entries(slotCount)
    .map(([time, info]) => ({ time, ...info }))
    .sort((a, b) => b.count - a.count)

  res.json({ data: result })
})

router.get('/trainer-utilization', async (req: Request, res: Response) => {
  const { storeId, startDate, endDate } = req.query as Record<string, string>
  const start = startDate ? dayjs(startDate).startOf('day') : dayjs().startOf('day')
  const end = endDate ? dayjs(endDate).endOf('day') : dayjs().add(30, 'day').endOf('day')

  const trainers = await prisma.trainer.findMany({
    where: { isActive: true, ...(storeId ? { storeId: Number(storeId) } : {}) },
    include: {
      _count: {
        select: {
          schedules: { where: { date: { gte: start.toDate(), lte: end.toDate() } } },
          bookings: { where: { status: { in: ['booked', 'checked_in', 'completed'] }, schedule: { date: { gte: start.toDate(), lte: end.toDate() } } } },
        },
      },
    },
  })

  const result = trainers.map(t => ({
    trainerId: t.id,
    trainerName: t.name,
    totalSlots: t._count.schedules,
    bookedSlots: t._count.bookings,
    utilizationRate: t._count.schedules > 0 ? Math.round((t._count.bookings / t._count.schedules) * 100) : 0,
  }))

  res.json({ data: result })
})

router.get('/member-remaining', async (req: Request, res: Response) => {
  const { lowThreshold } = req.query as Record<string, string>
  const threshold = lowThreshold ? Number(lowThreshold) : 5

  const packages = await prisma.memberPackage.findMany({
    where: { remainSlots: { lte: threshold } },
    include: { member: true, package: true },
    orderBy: { remainSlots: 'asc' },
  })

  const result = packages.map(p => ({
    memberId: p.memberId,
    memberName: p.member.name,
    memberPhone: p.member.phone,
    packageName: p.package.name,
    remainSlots: p.remainSlots,
    expireAt: p.expireAt,
  }))

  res.json({ data: result })
})

router.get('/abnormal-cancellations', async (req: Request, res: Response) => {
  const { startDate, endDate, storeId } = req.query as Record<string, string>
  const start = startDate ? dayjs(startDate).startOf('day') : dayjs().subtract(30, 'day').startOf('day')
  const end = endDate ? dayjs(endDate).endOf('day') : dayjs().endOf('day')

  const where: any = { status: 'cancelled', cancelledAt: { gte: start.toDate(), lte: end.toDate() } }
  if (storeId) where.storeId = Number(storeId)

  const cancellations = await prisma.booking.findMany({
    where,
    include: { member: true, trainer: true, store: true, schedule: true },
    orderBy: { cancelledAt: 'desc' },
  })

  const result = cancellations.map(b => ({
    bookingId: b.id,
    memberName: b.member.name,
    trainerName: b.trainer.name,
    storeName: b.store.name,
    date: b.schedule.date,
    startAt: b.schedule.startAt,
    cancelledAt: b.cancelledAt,
    cancelReason: b.cancelReason,
  }))

  res.json({ data: result })
})

router.get('/no-shows', async (req: Request, res: Response) => {
  const { startDate, endDate, storeId } = req.query as Record<string, string>
  const start = startDate ? dayjs(startDate).startOf('day') : dayjs().subtract(30, 'day').startOf('day')
  const end = endDate ? dayjs(endDate).endOf('day') : dayjs().endOf('day')

  const where: any = { status: 'no_show', createdAt: { gte: start.toDate(), lte: end.toDate() } }
  if (storeId) where.storeId = Number(storeId)

  const noShows = await prisma.booking.findMany({
    where,
    include: { member: true, trainer: true, store: true, schedule: true, noShow: true },
    orderBy: { createdAt: 'desc' },
  })

  const result = noShows.map(b => ({
    bookingId: b.id,
    memberName: b.member.name,
    trainerName: b.trainer.name,
    storeName: b.store.name,
    date: b.schedule.date,
    startAt: b.schedule.startAt,
    reason: b.noShow?.reason,
  }))

  res.json({ data: result })
})

router.get('/overview', async (req: Request, res: Response) => {
  const { storeId, startDate, endDate } = req.query as Record<string, string>
  const start = startDate ? dayjs(startDate).startOf('day') : dayjs().startOf('day')
  const end = endDate ? dayjs(endDate).endOf('day') : dayjs().add(30, 'day').endOf('day')

  const dateFilter = { gte: start.toDate(), lte: end.toDate() }
  const storeFilter = storeId ? Number(storeId) : undefined

  const [totalBookings, completedBookings, cancelledBookings, noShowBookings, activeMembers] = await Promise.all([
    prisma.booking.count({ where: { createdAt: dateFilter, ...(storeFilter ? { storeId: storeFilter } : {}) } }),
    prisma.booking.count({ where: { status: 'completed', createdAt: dateFilter, ...(storeFilter ? { storeId: storeFilter } : {}) } }),
    prisma.booking.count({ where: { status: 'cancelled', createdAt: dateFilter, ...(storeFilter ? { storeId: storeFilter } : {}) } }),
    prisma.booking.count({ where: { status: 'no_show', createdAt: dateFilter, ...(storeFilter ? { storeId: storeFilter } : {}) } }),
    prisma.member.count({ where: { bookings: { some: { createdAt: dateFilter, ...(storeFilter ? { storeId: storeFilter } : {}) } } } }),
  ])

  res.json({
    data: {
      totalBookings,
      completedBookings,
      cancelledBookings,
      noShowBookings,
      activeMembers,
      completionRate: totalBookings > 0 ? Math.round((completedBookings / totalBookings) * 100) : 0,
      cancellationRate: totalBookings > 0 ? Math.round((cancelledBookings / totalBookings) * 100) : 0,
      noShowRate: totalBookings > 0 ? Math.round((noShowBookings / totalBookings) * 100) : 0,
    },
  })
})

export default router

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

router.get('/slot-ledger', async (req: Request, res: Response) => {
  const { storeId, keyword, onlyActive } = req.query as Record<string, string>

  const where: any = {}
  if (storeId) {
    where.member = {
      bookings: {
        some: { storeId: Number(storeId) },
      },
    }
  }
  if (keyword) {
    where.member = {
      ...(where.member || {}),
      OR: [
        { name: { contains: keyword } },
        { phone: { contains: keyword } },
      ],
    }
  }

  const packages = await prisma.memberPackage.findMany({
    where,
    include: { member: true, package: true, _count: { select: { bookings: true } } },
    orderBy: [{ memberId: 'asc' }, { boughtAt: 'desc' }],
  })

  const now = new Date()
  const result = packages.map(p => ({
    memberId: p.memberId,
    memberName: p.member.name,
    memberPhone: p.member.phone,
    memberPackageId: p.id,
    packageName: p.package.name,
    totalSlots: p.package.totalSlots,
    remainSlots: p.remainSlots,
    usedSlots: p.package.totalSlots - p.remainSlots,
    usageRate: Math.round(((p.package.totalSlots - p.remainSlots) / p.package.totalSlots) * 100),
    usedCount: p._count.bookings,
    boughtAt: p.boughtAt,
    expireAt: p.expireAt,
    isExpired: p.expireAt ? p.expireAt < now : false,
    isExpiringSoon: p.expireAt
      ? dayjs(p.expireAt).diff(now, 'day') <= 14 && p.expireAt >= now
      : false,
    isActive: onlyActive === 'true' ? p.remainSlots > 0 && !(p.expireAt && p.expireAt < now) : true,
  }))

  const filtered = onlyActive === 'true' ? result.filter(r => r.isActive) : result

  res.json({
    data: filtered,
    summary: {
      totalPackages: filtered.length,
      totalRemainSlots: filtered.reduce((s, r) => s + r.remainSlots, 0),
      totalUsedSlots: filtered.reduce((s, r) => s + r.usedSlots, 0),
      expiringSoonCount: filtered.filter(r => r.isExpiringSoon).length,
      expiredCount: filtered.filter(r => r.isExpired).length,
    },
  })
})

router.get('/low-remaining-warning', async (req: Request, res: Response) => {
  const { lowThreshold, storeId, onlyExpiringSoon } = req.query as Record<string, string>
  const threshold = lowThreshold !== undefined ? Number(lowThreshold) : 3

  const where: any = { remainSlots: { lte: threshold, gt: 0 } }
  if (storeId) {
    where.member = { bookings: { some: { storeId: Number(storeId) } } }
  }

  const packages = await prisma.memberPackage.findMany({
    where,
    include: { member: true, package: true },
    orderBy: [{ remainSlots: 'asc' }, { expireAt: 'asc' as any }],
  })

  const now = new Date()
  const result = packages.map(p => {
    const daysToExpire = p.expireAt ? dayjs(p.expireAt).diff(now, 'day') : null
    return {
      memberId: p.memberId,
      memberName: p.member.name,
      memberPhone: p.member.phone,
      memberPackageId: p.id,
      packageName: p.package.name,
      remainSlots: p.remainSlots,
      totalSlots: p.package.totalSlots,
      expireAt: p.expireAt,
      daysToExpire,
      isExpiringSoon: daysToExpire !== null && daysToExpire <= 14 && daysToExpire >= 0,
      urgencyLevel: p.remainSlots <= 1 ? 'critical' : p.remainSlots <= threshold / 2 ? 'high' : 'medium',
      storeIds: Array.from(new Set([storeId ? Number(storeId) : null])).filter(Boolean),
    }
  })

  const filtered = onlyExpiringSoon === 'true' ? result.filter(r => r.isExpiringSoon) : result

  res.json({
    data: filtered,
    summary: {
      totalMembers: filtered.length,
      criticalCount: filtered.filter(r => r.urgencyLevel === 'critical').length,
      highCount: filtered.filter(r => r.urgencyLevel === 'high').length,
      expiringSoonCount: filtered.filter(r => r.isExpiringSoon).length,
    },
  })
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

router.get('/anomaly-dashboard', async (req: Request, res: Response) => {
  const { storeId, startDate, endDate, cancelThreshold, noShowThreshold, urgencyHours } = req.query as Record<string, string>
  const start = startDate ? dayjs(startDate).startOf('day') : dayjs().subtract(30, 'day').startOf('day')
  const end = endDate ? dayjs(endDate).endOf('day') : dayjs().endOf('day')
  const cancelLimit = cancelThreshold ? Number(cancelThreshold) : 2
  const noShowLimit = noShowThreshold ? Number(noShowThreshold) : 1
  const urgentLimitHours = urgencyHours ? Number(urgencyHours) : 24

  const dateFilter = { gte: start.toDate(), lte: end.toDate() }
  const storeFilter = storeId ? Number(storeId) : undefined

  const stores = await prisma.store.findMany({
    where: storeFilter ? { id: storeFilter } : { isActive: true },
    select: { id: true, name: true },
  })

  const result: Record<string, any> = { summary: {}, byStore: {} }

  let allFrequentCancellers: any[] = []
  let allFrequentNoShows: any[] = []
  let allPendingUnconfirmed: any[] = []

  const now = dayjs()

  for (const store of stores) {
    const cancelledBookings = await prisma.booking.findMany({
      where: {
        storeId: store.id,
        status: 'cancelled',
        cancelledAt: dateFilter,
      },
      include: { member: true, schedule: true },
    })

    const noShowBookings = await prisma.booking.findMany({
      where: {
        storeId: store.id,
        status: 'no_show',
        createdAt: dateFilter,
      },
      include: { member: true, schedule: true, noShow: true },
    })

    const pendingUnconfirmed = await prisma.booking.findMany({
      where: {
        storeId: store.id,
        status: 'booked',
        schedule: { date: dateFilter },
      },
      include: { member: true, schedule: true },
      orderBy: [{ schedule: { date: 'asc' } }, { schedule: { startAt: 'asc' } }],
    })

    const cancelByMember: Record<number, any[]> = {}
    for (const b of cancelledBookings) {
      if (!cancelByMember[b.memberId]) cancelByMember[b.memberId] = []
      cancelByMember[b.memberId].push(b)
    }
    const frequentCancellers = Object.entries(cancelByMember)
      .filter(([, list]) => list.length >= cancelLimit)
      .map(([mid, list]) => ({
        memberId: Number(mid),
        memberName: list[0].member.name,
        memberPhone: list[0].member.phone,
        cancelCount: list.length,
        recentCancels: list.slice(0, 5).map(b => ({
          bookingId: b.id,
          date: b.schedule.date,
          startAt: b.schedule.startAt,
          cancelReason: b.cancelReason,
          cancelledAt: b.cancelledAt,
        })),
      }))

    const noShowByMember: Record<number, any[]> = {}
    for (const b of noShowBookings) {
      if (!noShowByMember[b.memberId]) noShowByMember[b.memberId] = []
      noShowByMember[b.memberId].push(b)
    }
    const frequentNoShows = Object.entries(noShowByMember)
      .filter(([, list]) => list.length >= noShowLimit)
      .map(([mid, list]) => ({
        memberId: Number(mid),
        memberName: list[0].member.name,
        memberPhone: list[0].member.phone,
        noShowCount: list.length,
        recentNoShows: list.slice(0, 5).map(b => ({
          bookingId: b.id,
          date: b.schedule.date,
          startAt: b.schedule.startAt,
          reason: b.noShow?.reason,
        })),
      }))

    const unconfirmedList = pendingUnconfirmed
      .map(b => {
        const startDateTime = dayjs(b.schedule.date).hour(Number(b.schedule.startAt.split(':')[0]))
        const hoursUntilStart = Math.round(startDateTime.diff(now, 'minute') / 60 * 10) / 10
        const isUrgent = hoursUntilStart <= urgentLimitHours && hoursUntilStart >= -24
        return {
          bookingId: b.id,
          memberId: b.memberId,
          memberName: b.member.name,
          memberPhone: b.member.phone,
          date: b.schedule.date,
          startAt: b.schedule.startAt,
          hoursUntilStart,
          isUrgent,
          urgency: hoursUntilStart <= 1 ? 'critical' : hoursUntilStart <= 4 ? 'high' : hoursUntilStart <= urgentLimitHours ? 'medium' : 'normal',
          status: hoursUntilStart < 0 ? 'overdue' : 'upcoming',
        }
      })
      .sort((a, b) => a.hoursUntilStart - b.hoursUntilStart)

    result.byStore[store.id] = {
      storeId: store.id,
      storeName: store.name,
      frequentCancellers,
      frequentNoShows,
      pendingUnconfirmed: unconfirmedList,
      counts: {
        totalCancelled: cancelledBookings.length,
        totalNoShows: noShowBookings.length,
        totalPendingUnconfirmed: unconfirmedList.length,
        urgentUnconfirmed: unconfirmedList.filter(u => u.isUrgent).length,
        overdueUnconfirmed: unconfirmedList.filter(u => u.status === 'overdue').length,
      },
    }

    allFrequentCancellers = allFrequentCancellers.concat(frequentCancellers.map(x => ({ ...x, storeId: store.id, storeName: store.name })))
    allFrequentNoShows = allFrequentNoShows.concat(frequentNoShows.map(x => ({ ...x, storeId: store.id, storeName: store.name })))
    allPendingUnconfirmed = allPendingUnconfirmed.concat(unconfirmedList.map(x => ({ ...x, storeId: store.id, storeName: store.name })))
  }

  result.summary = {
    periodStart: start.toDate(),
    periodEnd: end.toDate(),
    urgencyHours: urgentLimitHours,
    totalFrequentCancellers: allFrequentCancellers.length,
    totalFrequentNoShows: allFrequentNoShows.length,
    totalPendingUnconfirmed: allPendingUnconfirmed.length,
    urgentUnconfirmed: allPendingUnconfirmed.filter(u => u.isUrgent).length,
    overdueUnconfirmed: allPendingUnconfirmed.filter(u => u.status === 'overdue').length,
    cancelThreshold: cancelLimit,
    noShowThreshold: noShowLimit,
  }

  res.json({ data: result })
})

export default router

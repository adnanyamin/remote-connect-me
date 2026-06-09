import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';

const ADMIN_EMAILS = ['ayamin@gmail.com'];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const user = await getSessionUser(req);
  if (!user || !ADMIN_EMAILS.includes(user.email.toLowerCase())) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const [users, devices] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        emailVerifiedAt: true,
        mfaEnabledAt: true,
        createdAt: true,
        memberships: {
          select: {
            role: true,
            org: { select: { id: true, name: true, personal: true } },
          },
        },
        devices: {
          select: {
            id: true,
            name: true,
            platform: true,
            lastSeenAt: true,
            createdAt: true,
          },
        },
      },
    }),
    prisma.device.count(),
  ]);

  const now = Date.now();
  const onlineCount = users.reduce((sum, u) =>
    sum + u.devices.filter(d => d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() < 60_000).length, 0);

  return res.status(200).json({
    stats: {
      totalUsers:      users.length,
      verifiedUsers:   users.filter(u => u.emailVerifiedAt).length,
      unverifiedUsers: users.filter(u => !u.emailVerifiedAt).length,
      totalDevices:    devices,
      onlineDevices:   onlineCount,
      last24h:         users.filter(u => now - new Date(u.createdAt).getTime() < 86_400_000).length,
      last7d:          users.filter(u => now - new Date(u.createdAt).getTime() < 7 * 86_400_000).length,
    },
    users: users.map(u => ({
      id:            u.id,
      email:         u.email,
      verified:      !!u.emailVerifiedAt,
      mfaEnabled:    !!u.mfaEnabledAt,
      createdAt:     u.createdAt,
      deviceCount:   u.devices.length,
      onlineDevices: u.devices.filter(d => d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() < 60_000).length,
      orgs:          u.memberships.map(m => ({ name: m.org.name, role: m.role, personal: m.org.personal })),
      devices:       u.devices.map(d => ({
        id:        d.id,
        name:      d.name,
        platform:  d.platform,
        lastSeenAt: d.lastSeenAt,
        online:    !!(d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() < 60_000),
        createdAt: d.createdAt,
      })),
    })),
  });
}

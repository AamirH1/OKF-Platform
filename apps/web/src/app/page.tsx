'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useMe } from '@/lib/session';

export default function Home() {
  const { data, isLoading } = useMe();
  const router = useRouter();
  React.useEffect(() => {
    if (!isLoading) router.replace(data ? '/dashboard' : '/home');
  }, [data, isLoading, router]);
  return null;
}

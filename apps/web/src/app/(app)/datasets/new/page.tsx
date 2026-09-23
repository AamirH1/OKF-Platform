'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { createDatasetSchema, type DatasetDTO } from '@okf/shared';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PageHeader } from '@/components/common';
import { BundleUploader } from '@/components/upload';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { useCurrentOrg, useRequireAuth } from '@/lib/session';

const formSchema = createDatasetSchema.omit({ tags: true, organizationId: true }).extend({ tagsText: z.string().max(500) });

export default function NewDatasetPage() {
  useRequireAuth();
  const { org } = useCurrentOrg();
  const router = useRouter();
  const [created, setCreated] = React.useState<DatasetDTO | null>(null);
  const form = useForm<z.input<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '', description: '', visibility: 'organization', license: '', tagsText: '' },
  });
  const create = useMutation({
    mutationFn: (v: z.output<typeof formSchema>) =>
      api<DatasetDTO>('/datasets', {
        method: 'POST',
        body: {
          organizationId: org!.id,
          name: v.name,
          description: v.description,
          visibility: v.visibility,
          license: v.license || null,
          tags: v.tagsText.split(',').map((t) => t.trim()).filter(Boolean),
        },
      }),
    onSuccess: setCreated,
  });

  if (created) {
    return (
      <>
        <PageHeader title={created.name} eyebrow="New dataset" description="Upload the first version of the bundle. Processing starts automatically." />
        <Card>
          <CardHeader>
            <CardTitle>Upload OKF bundle</CardTitle>
            <CardDescription>Accepted: .zip, .tar.gz, .tgz, .tar, or a single .md concept.</CardDescription>
          </CardHeader>
          <CardContent>
            <BundleUploader datasetId={created.id} onFinished={() => router.push(`/datasets/${created.id}`)} />
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="New dataset" description={org ? `A dataset is a versioned OKF bundle in ${org.name}.` : undefined} />
      {!org ? <Alert tone="warning">Create or join an organization first.</Alert> : null}
      <Card className="max-w-2xl">
        <CardContent className="pt-5">
          <form onSubmit={form.handleSubmit((v) => create.mutate(formSchema.parse(v)))} className="space-y-4" noValidate>
            <Field label="Name" htmlFor="name" error={form.formState.errors.name?.message}>
              <Input id="name" {...form.register('name')} placeholder="Sales warehouse knowledge" />
            </Field>
            <Field label="Description" htmlFor="description">
              <Textarea id="description" {...form.register('description')} rows={3} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Visibility" htmlFor="visibility" hint="Public datasets are only visible once a version is published.">
                <Select id="visibility" {...form.register('visibility')}>
                  <option value="organization">Organization — all members</option>
                  <option value="private">Private — you, admins and people you share with</option>
                  <option value="public">Public — anyone, after publishing</option>
                </Select>
              </Field>
              <Field label="License (optional)" htmlFor="license" hint="Platform metadata; OKF defines no license field.">
                <Input id="license" {...form.register('license')} placeholder="CC-BY-4.0" />
              </Field>
            </div>
            <Field label="Tags" htmlFor="tags" hint="Comma-separated platform tags (separate from OKF concept tags)." error={form.formState.errors.tagsText?.message}>
              <Input id="tags" {...form.register('tagsText')} placeholder="sales, finance" />
            </Field>
            <Button type="submit" disabled={!org || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create and continue to upload'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </>
  );
}

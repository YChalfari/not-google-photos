import { useParams } from 'react-router-dom';
import { Page } from '@/components/states';

export function MemoryPage() {
  const { id } = useParams();
  return (
    <Page
      title="Memory"
      lede="Memories will open here. This one was opened from a notification, and the screen for it is still to come."
    >
      {id ? <p className="text-sm text-muted-foreground">Reference {id}.</p> : null}
    </Page>
  );
}

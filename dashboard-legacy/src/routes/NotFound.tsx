// NotFound — the 404 (foundation-built). Any unmatched in-app path lands here.
import { useNavigate } from 'react-router-dom';
import { Button, EmptyState } from '../ui/index.js';

export default function NotFound(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <EmptyState
      title="Page not found"
      description="That page doesn't exist."
      action={
        <Button variant="secondary" onClick={() => navigate('/')}>
          Back to inbox
        </Button>
      }
    />
  );
}

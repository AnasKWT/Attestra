'use client';

import { SearchView } from '@/components/explorer/SearchView';
import { ToolFrame } from '@/components/sandbox/ToolFrame';

export default function SearchTool() {
  return (
    <ToolFrame slug="search">
      <SearchView />
    </ToolFrame>
  );
}

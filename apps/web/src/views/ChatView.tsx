import { Layout } from "@/components/Layout";
import { Sidebar } from "@/components/Sidebar";
import { Chat } from "@/components/Chat";
import { Composer } from "@/components/Composer";
import { Inspector } from "@/components/Inspector";
import { StatusBar } from "@/components/chrome/StatusBar";
import { ExtUiDialog } from "@/components/chat/ExtUiDialog";
import { AdvisorPanel } from "@/components/chat/AdvisorPanel";
import { selectActiveSession, useStore } from "@/lib/store";

export function ChatView() {
	const session = useStore(selectActiveSession);
	return (
		<>
			<Layout
				sidebar={<Sidebar />}
				main={
					<div className="flex h-full min-h-0 flex-col">
						<Chat />
						{session && !session.readOnly && <AdvisorPanel sessionId={session.sessionId} />}
						{/* Keyed so each session gets its own draft, attachments and pickers. */}
						<Composer key={session?.sessionId} />
					</div>
				}
				inspector={<Inspector />}
				topBar={<StatusBar />}
			/>
			<ExtUiDialog />
		</>
	);
}

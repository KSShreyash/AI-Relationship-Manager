-- Drop the old constraint and add the correct one
alter table public.chat_messages drop constraint chat_messages_user_id_graph_message_id_key;
alter table public.chat_messages add unique (user_id, graph_chat_id, graph_message_id);

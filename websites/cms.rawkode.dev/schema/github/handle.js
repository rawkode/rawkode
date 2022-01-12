import React from "react";
import { TextInput, Stack, Label } from "@sanity/ui";
import { SiGithub } from "react-icons/si";

export const Handle = React.forwardRef((props, ref) => {
  return (
    <Stack space={2}>
      <Label>{props.type.title}</Label>
      <TextInput ref={ref} value={props.value} icon={SiGithub} />
    </Stack>
  );
});

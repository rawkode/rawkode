export const HelloWorldBadge = (props) => {
  return {
    label: "Hello world",
    title: "Hello I am a custom document badge",
    color: "success",
  };
};

export const HelloWorldAction = (props) => {
  return {
    label: "Hello world",
    onHandle: () => {
      // Here you can perform your actions
      window.alert("👋 Hello from custom action");
    },
  };
};
